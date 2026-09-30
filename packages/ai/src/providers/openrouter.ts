import { Effect, Schema } from "effect"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { HttpOptions, ProviderID, type CacheHint, type ModelID, type OpenString } from "../schema/index.js"
import type { ProviderPackage } from "../provider-package.js"
import { SystemOne } from "../experimental/system-one.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { OpenAIResponses } from "../protocols/openai-responses.js"
import { XAIResponses } from "../protocols/xai-responses.js"
import { MetaResponses } from "../protocols/meta-responses.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { Framing } from "../route/framing.js"
import { newBreakpoints, ttlBucket } from "../protocols/utils/cache.js"
import { OpenRouterWire } from "../protocols/utils/openrouter.js"

export const id = ProviderID.make("openrouter")
const baseURL = "https://openrouter.ai/api/v1"
const ADAPTER = "openrouter"

export interface OpenRouterProviderRouting {
  readonly [key: string]: unknown
  readonly order?: ReadonlyArray<string>
  readonly allow_fallbacks?: boolean
  readonly require_parameters?: boolean
  readonly data_collection?: OpenString<"allow" | "deny">
  readonly only?: ReadonlyArray<string>
  readonly ignore?: ReadonlyArray<string>
  readonly quantizations?: ReadonlyArray<string>
  readonly sort?: OpenString<"price" | "throughput" | "latency">
  readonly max_price?: Readonly<{
    prompt?: number | string
    completion?: number | string
    image?: number | string
    audio?: number | string
    request?: number | string
  }>
  readonly zdr?: boolean
}

export type OpenRouterPlugin =
  | Readonly<{
      id: "web"
      max_results?: number
      search_prompt?: string
      engine?: OpenString<"native" | "exa">
    }>
  | Readonly<{ id: "file-parser"; max_files?: number; pdf?: { engine?: string } }>
  | Readonly<{ id: "moderation" }>
  | Readonly<{ id: "response-healing" }>
  | Readonly<{ id: "auto-router"; allowed_models?: ReadonlyArray<string> }>
  | Readonly<{ id: string & {}; [key: string]: unknown }>

export interface OpenRouterOptions {
  readonly [key: string]: unknown
  readonly debug?: Readonly<{ echo_upstream_body?: boolean }>
  readonly models?: ReadonlyArray<string>
  readonly plugins?: ReadonlyArray<OpenRouterPlugin>
  readonly provider?: OpenRouterProviderRouting
  readonly reasoning?: Readonly<{
    enabled?: boolean
    exclude?: boolean
    effort?: OpenString<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">
    max_tokens?: number
  }>
  readonly usage?: boolean | Readonly<{ include: boolean }>
  readonly user?: string
  readonly web_search_options?: Readonly<{
    max_results?: number
    search_prompt?: string
    engine?: OpenString<"native" | "exa">
  }>
}

export type OpenRouterProviderOptionsInput = OpenRouterOptions

export interface OpenRouterEvaluationOptions {
  readonly [key: string]: unknown
  readonly provider?: OpenRouterProviderRouting
  readonly session_id?: string
  readonly trace?: Readonly<Record<string, unknown>>
  readonly user?: string
}

export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenRouterProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenRouterProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

const OpenRouterBody = Schema.StructWithRest(Schema.Struct(OpenAIChat.bodyFields), [
  Schema.Record(Schema.String, Schema.Any),
])
export type OpenRouterBody = Schema.Schema.Type<typeof OpenRouterBody>

const ResponsesReasoning = Schema.StructWithRest(
  Schema.Struct({
    enabled: Schema.optional(Schema.Boolean),
    exclude: Schema.optional(Schema.Boolean),
    effort: Schema.optional(Schema.String),
    max_tokens: Schema.optional(Schema.Number),
    summary: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const responsesFields = {
  store: Schema.Literal(false),
  reasoning: Schema.optional(ResponsesReasoning),
}
const OpenRouterResponsesBody = Schema.StructWithRest(
  Schema.Struct({ ...OpenAIResponses.OpenAIResponsesBody.fields, ...responsesFields }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const OpenRouterXAIResponsesBody = Schema.StructWithRest(
  Schema.Struct({ ...XAIResponses.XAIResponsesBody.fields, ...responsesFields }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const OpenRouterMetaResponsesBody = Schema.StructWithRest(
  Schema.Struct({ ...MetaResponses.Body.fields, ...responsesFields }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const OpenRouterMessagesBody = Schema.StructWithRest(AnthropicMessages.AnthropicMessagesBody, [
  Schema.Record(Schema.String, Schema.Unknown),
])
type OpenRouterMessagesBody = Schema.Schema.Type<typeof OpenRouterMessagesBody>

export const protocol = Protocol.make({
  id: "openrouter-chat",
  body: {
    schema: OpenRouterBody,
    from: (request) =>
      OpenAIChat.fromRequest(request, { cacheControl: cacheControl() }).pipe(
        Effect.map((body) => {
          const sourceAssistants = request.messages.filter((message) => message.role === "assistant")
          let assistantIndex = 0
          const messages = body.messages.map((message) => {
            if (message.role !== "assistant") return message
            const source = sourceAssistants[assistantIndex++]
            const reasoning = source?.content
              .filter((part) => part.type === "reasoning")
              .map((part) => part.text)
              .join("")
            const reasoningDetails = Array.isArray(message.reasoning_details) ? message.reasoning_details : undefined
            return {
              ...message,
              reasoning_content: undefined,
              reasoning_text: undefined,
              reasoning: reasoning && reasoningDetails && reasoningDetails.length > 0 ? reasoning : undefined,
              reasoning_details: reasoningDetails,
            }
          })
          return {
            ...body,
            messages,
            ...OpenRouterWire.bodyOptions(request.providerOptions, request.generation?.maxTokens),
          } as OpenRouterBody
        }),
      ),
  },
  stream: OpenAIChat.protocol.stream,
})

const responsesProtocol = Protocol.make({
  ...OpenAIResponses.protocol,
  id: "openrouter-responses",
  body: {
    schema: OpenRouterResponsesBody,
    from: (request) =>
      OpenAIResponses.protocol.body
        .from(OpenRouterWire.nativeRequest(request, "responses"))
        .pipe(Effect.map((body) => OpenRouterWire.responsesOptions(request, body))),
  },
})
const xaiProtocol = Protocol.make({
  ...XAIResponses.protocol,
  id: "openrouter-xai-responses",
  body: {
    schema: OpenRouterXAIResponsesBody,
    from: (request) =>
      XAIResponses.protocol.body
        .from(OpenRouterWire.nativeRequest(request, "responses"))
        .pipe(Effect.map((body) => OpenRouterWire.responsesOptions(request, body))),
  },
})
const metaProtocol = Protocol.make({
  ...MetaResponses.protocol,
  id: "openrouter-meta-responses",
  body: {
    schema: OpenRouterMetaResponsesBody,
    from: (request) =>
      MetaResponses.protocol.body
        .from(OpenRouterWire.nativeRequest(request, "responses"))
        .pipe(Effect.map((body) => OpenRouterWire.responsesOptions(request, body))),
  },
})
const messagesProtocol = Protocol.make({
  ...AnthropicMessages.protocol,
  id: "openrouter-messages",
  body: {
    schema: OpenRouterMessagesBody,
    from: (request) =>
      AnthropicMessages.protocol.body.from(OpenRouterWire.nativeRequest(request, "messages")).pipe(
        Effect.map((body) => {
          const {
            reasoning: _,
            usage: _usage,
            ...options
          } = OpenRouterWire.bodyOptions(request.providerOptions, body.max_tokens)
          return { ...options, ...body }
        }),
      ),
  },
})

const cacheControl = () => {
  const breakpoints = newBreakpoints(4)
  return (cache: CacheHint | undefined) => {
    if (cache === undefined || breakpoints.remaining === 0) return undefined
    breakpoints.remaining -= 1
    return {
      type: "ephemeral" as const,
      ...(ttlBucket(cache.ttlSeconds) === "1h" ? { ttl: "1h" } : {}),
    }
  }
}

export const route = Route.make({
  id: ADAPTER,
  provider: id,
  providerMetadataKey: "openrouter",
  protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL }),
  framing: OpenAIChat.framing,
})

const responsesRoute = Route.make({
  id: "openrouter-responses",
  provider: id,
  providerMetadataKey: "openrouter",
  protocol: responsesProtocol,
  endpoint: Endpoint.path("/responses", { baseURL }),
  framing: Framing.sse,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})
const xaiRoute = Route.make({
  id: "openrouter-xai-responses",
  provider: id,
  providerMetadataKey: "openrouter",
  protocol: xaiProtocol,
  endpoint: Endpoint.path("/responses", { baseURL }),
  framing: Framing.sse,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})
const metaRoute = Route.make({
  id: "openrouter-meta-responses",
  provider: id,
  providerMetadataKey: "openrouter",
  protocol: metaProtocol,
  endpoint: Endpoint.path("/responses", { baseURL }),
  framing: Framing.sse,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})
const messagesRoute = Route.make({
  id: "openrouter-messages",
  provider: id,
  providerMetadataKey: "openrouter",
  protocol: messagesProtocol,
  endpoint: Endpoint.path("/messages", { baseURL }),
  transport: AnthropicMessages.transport<OpenRouterMessagesBody>(),
})

export const routes = [route, responsesRoute, xaiRoute, metaRoute, messagesRoute]

const routeOptions = (input: LanguageModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL: endpoint, ...rest } = input
  return {
    ...rest,
    endpoint: { baseURL: endpoint ?? baseURL },
    auth: AuthOptions.bearer(input, "OPENROUTER_API_KEY"),
  }
}

export const configure = (input: LanguageModelOptions = {}) => {
  const options = routeOptions(input)
  const chatRoute = route.with(options)
  const openaiResponses = responsesRoute.with(options)
  const xaiResponses = xaiRoute.with(options)
  const metaResponses = metaRoute.with(options)
  const anthropicMessages = messagesRoute.with(options)
  const chat = (modelID: string | ModelID) =>
    chatRoute.model<OpenRouterProviderOptionsInput>({ id: modelID, compatibility: { supportsPromptCacheKey: true } })
  const responses = (modelID: string | ModelID) => {
    const model = String(modelID).replace(/^~/, "")
    return (
      model.startsWith("x-ai/") ? xaiResponses : model.startsWith("meta/") ? metaResponses : openaiResponses
    ).model<OpenRouterProviderOptionsInput>({ id: modelID })
  }
  const messages = (modelID: string | ModelID) =>
    anthropicMessages.model<OpenRouterProviderOptionsInput>({ id: modelID })
  const evaluation = (modelID: string | ModelID) =>
    SystemOne.model<OpenRouterEvaluationOptions>({
      id: modelID,
      provider: id,
      providerMetadataKey: "openrouter",
      auth: AuthOptions.bearer(input, "OPENROUTER_API_KEY"),
      baseURL: input.baseURL ?? baseURL,
      headers: input.headers,
      http: HttpOptions.make(input.http),
    })
  return {
    id,
    model: (modelID: string | ModelID) => {
      const model = String(modelID).replace(/^~/, "")
      if (model.startsWith("anthropic/")) return messages(modelID)
      if (["openai/", "x-ai/", "meta/"].some((prefix) => model.startsWith(prefix))) return responses(modelID)
      return chat(modelID)
    },
    chat,
    responses,
    messages,
    experimental: { evaluation },
    configure,
  }
}

export const provider = configure()
export const chat = provider.chat
export const responses = provider.responses
export const messages = provider.messages
export const experimental = provider.experimental
export const model: ProviderPackage.Definition<Settings, OpenRouterProviderOptionsInput>["model"] = (
  modelID,
  { apiKey, baseURL, body, headers, ...providerOptions },
) =>
  configure({
    apiKey,
    baseURL,
    headers,
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).model(modelID)

export * as OpenRouter from "./openrouter.js"
