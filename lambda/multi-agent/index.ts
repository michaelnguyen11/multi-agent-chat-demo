import { Logger } from "@aws-lambda-powertools/logger";
import {
  MultiAgentOrchestrator,
  BedrockLLMAgent,
  BedrockLLMAgentOptions,
  DynamoDbChatStorage,
  AmazonKnowledgeBasesRetriever,
  LambdaAgent,
  BedrockClassifier,
} from "multi-agent-orchestrator";
import { APIGatewayProxyEventV2, Handler, Context } from "aws-lambda";
import { Buffer } from "buffer";
import { GREETING_AGENT_PROMPT, BA_AGENT_PROMPT, PO_AGENT_PROMPT, PM_AGENT_PROMPT, TECH_AGENT_PROMPT } from "./prompts";
import { BedrockAgentRuntimeClient, SearchType } from '@aws-sdk/client-bedrock-agent-runtime';

const logger = new Logger();

declare global {
  namespace awslambda {
    function streamifyResponse(
      f: (
        event: APIGatewayProxyEventV2,
        responseStream: NodeJS.WritableStream,
        context: Context
      ) => Promise<void>
    ): Handler;
  }
}

interface BodyData {
  query: string;
  sessionId: string;
  userId: string;
}

const storage = new DynamoDbChatStorage(
  process.env.HISTORY_TABLE_NAME!,
  process.env.AWS_REGION!,
  process.env.HISTORY_TABLE_TTL_KEY_NAME,
  Number(process.env.HISTORY_TABLE_TTL_DURATION),
);

const orchestrator = new MultiAgentOrchestrator({
  storage: storage,
  config: {
    LOG_AGENT_CHAT: true,
    LOG_CLASSIFIER_CHAT: true,
    LOG_CLASSIFIER_RAW_OUTPUT: true,
    LOG_CLASSIFIER_OUTPUT: true,
    LOG_EXECUTION_TIMES: true,
  },
  logger: logger,
  classifier: new BedrockClassifier({
    modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
  }),
});


const baAgent = new BedrockLLMAgent({
  name: "Business Analyst Agent",
  description:
    "The Business Analyst Assistant that transforms stakeholder business requirements into foundational documents used to create a Business Requirements Document (BRD) and a Functional Specification Document (FSD).",
  modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
} as BedrockLLMAgentOptions);

baAgent.setSystemPrompt(BA_AGENT_PROMPT);


const poAgent = new BedrockLLMAgent({
  name: "Product Owner Agent",
  description:
    "The Product Owner Assistant that transforms stakeholder business requirements into detailed sprint backlog items.",
  modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
} as BedrockLLMAgentOptions);

poAgent.setSystemPrompt(PO_AGENT_PROMPT);


const pmAgent = new BedrockLLMAgent({
  name: "Product Manager Agent",
  description:
    "The Project Manager Assistant that transforms stakeholder business requirements into a comprehensive sprint plan and status report.",
  modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
} as BedrockLLMAgentOptions);

pmAgent.setSystemPrompt(PM_AGENT_PROMPT);


if (process.env.LAMBDA_AGENTS){
  const lambdaAgents = JSON.parse(process.env.LAMBDA_AGENTS);
  for (const agent of lambdaAgents) {
    orchestrator.addAgent(new LambdaAgent({
      name: agent.name,
      description: agent.description,
      functionName: agent.functionName,
      functionRegion: agent.region
    }
    ));
  }
}

// Add a our Multi-agent orchestrator documentation agent
const maoDocAgent = new BedrockLLMAgent({
  name: "Tech agent",
  description:
    "A tech expert specializing in the multi-agent orchestrator framework, technical domains, and AI-driven solutions.",
  modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
  streaming: true,
  inferenceConfig: {
    temperature: 0.0,
  },
  customSystemPrompt:{
    template:`
  You are a tech expert specializing in both the technical domain, including software development, AI, cloud computing, and the multi-agent orchestrator framework. Your role is to provide comprehensive, accurate, and helpful information about these areas, with a specific focus on the orchestrator framework, its agents, and their applications. Always structure your responses using clear, well-formatted markdown.

        Key responsibilities:
        - Explain the multi-agent orchestrator framework, its agents, and its benefits
        - Guide users on how to get started with the framework and configure agents
        - Provide technical advice on topics like software development, AI, and cloud computing
        - Detail the process of creating and configuring an orchestrator
        - Describe the various components and elements of the framework
        - Provide examples and best practices for technical implementation

        When responding to queries:
        1. Start with a brief overview of the topic
        2. Break down complex concepts into clear, digestible sections
        3. **When the user asks for an example or code, always respond with a code snippet, using proper markdown syntax for code blocks (\`\`\`).** Provide explanations alongside the code when necessary.
        4. Conclude with next steps or additional resources if relevant

        Always use proper markdown syntax, including:
        - Headings (##, ###) for main sections and subsections
        - Bullet points (-) or numbered lists (1., 2., etc.) for enumerating items
        - Code blocks (\`\`\`) for code snippets or configuration examples
        - Bold (**text**) for emphasizing key terms or important points
        - Italic (*text*) for subtle emphasis or introducing new terms
        - Links ([text](URL)) when referring to external resources or documentation

        Tailor your responses to both beginners and experienced developers, providing clear explanations and technical depth as appropriate.`
  },
  retriever: new AmazonKnowledgeBasesRetriever(
    new BedrockAgentRuntimeClient(),
    {
      knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID,
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 10,
          overrideSearchType: SearchType.HYBRID,
        },
      },
    }
  )
  });
orchestrator.addAgent(maoDocAgent);

//orchestrator.addAgent(techAgent);
orchestrator.addAgent(baAgent);
orchestrator.addAgent(poAgent);
orchestrator.addAgent(pmAgent);

const greetingAgent = new BedrockLLMAgent({
  name: "Greeting Agent",
  description: "Welcome the user and list him the available agents",
  streaming: true,
  inferenceConfig: {
    temperature: 0.0,
  },
  saveChat: false,
});

const agents = orchestrator.getAllAgents();
const agentList = Object.entries(agents)
  .map(([agentKey, agentInfo], index) => {
    const name = (agentInfo as any).name || agentKey;
    const description = (agentInfo as any).description;
    return `${index + 1}. **${name}**: ${description}`;
  })
  .join('\n\n');
greetingAgent.setSystemPrompt(GREETING_AGENT_PROMPT(agentList));



orchestrator.addAgent(greetingAgent);


async function eventHandler(
  event: APIGatewayProxyEventV2,
  responseStream: NodeJS.WritableStream
) {
  logger.info(event);

  try {
    const userBody = JSON.parse(event.body as string) as BodyData;
    const userId = userBody.userId;
    const sessionId = userBody.sessionId;

    logger.info("calling the orchestrator");
    const response = await orchestrator.routeRequest(
      userBody.query,
      userId,
      sessionId
    );

    logger.info("response from the orchestrator");

    let safeBuffer = Buffer.from(
      JSON.stringify({
        type: "metadata",
        data: response,
      }) + "\n",
      "utf8"
    );

    responseStream.write(safeBuffer);

    if (response.streaming == true) {
      logger.info("\n** RESPONSE STREAMING ** \n");
      // Send metadata immediately
      logger.info(` > Agent ID: ${response.metadata.agentId}`);
      logger.info(` > Agent Name: ${response.metadata.agentName}`);

      logger.info(`> User Input: ${response.metadata.userInput}`);
      logger.info(`> User ID: ${response.metadata.userId}`);
      logger.info(`> Session ID: ${response.metadata.sessionId}`);
      logger.info(
        `> Additional Parameters:`,
        response.metadata.additionalParams
      );
      logger.info(`\n> Response: `);

      for await (const chunk of response.output) {
        if (typeof chunk === "string") {
          process.stdout.write(chunk);

          safeBuffer = Buffer.from(
            JSON.stringify({
              type: "chunk",
              data: chunk,
            }) + "\n"
          );

          responseStream.write(safeBuffer);
        } else {
          logger.error("Received unexpected chunk type:", typeof chunk);
        }
      }
    } else {
      // Handle non-streaming response (AgentProcessingResult)
      logger.info("\n** RESPONSE ** \n");
      logger.info(` > Agent ID: ${response.metadata.agentId}`);
      logger.info(` > Agent Name: ${response.metadata.agentName}`);
      logger.info(`> User Input: ${response.metadata.userInput}`);
      logger.info(`> User ID: ${response.metadata.userId}`);
      logger.info(`> Session ID: ${response.metadata.sessionId}`);
      logger.info(
        `> Additional Parameters:`,
        response.metadata.additionalParams
      );
      logger.info(`\n> Response: ${response.output}`);

      safeBuffer = Buffer.from(
        JSON.stringify({
          type: "complete",
          data: response.output,
        })
      );

      responseStream.write(safeBuffer);
    }
  } catch (error) {
    logger.error("Error: " + error);

    responseStream.write(
      JSON.stringify({
        response: error,
      })
    );
  } finally {
    responseStream.end();
  }
}

export const handler = awslambda.streamifyResponse(eventHandler);
