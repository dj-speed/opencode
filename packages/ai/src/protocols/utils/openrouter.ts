export * as OpenRouterWire from "./openrouter.js"

import { Option, Schema } from "effect"
import { LLMRequest, Message, type ContentPart, type ReasoningPart } from "../../schema/index.js"
import { resolveEffortUpdates } from "../../effort-updates.js"
import type { OpenResponses } from "../open-responses.js"
import { OpenResponsesOptions } from "./open-responses-options.js"
import { isRecord, ProviderShared } from "../shared.js"

const ReplayDetail = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.NullOr(Schema.String)),
  data: Schema.optional(Schema.String),
  encrypted: Schema.optional(Schema.String),
})
const decodeReplayDetail = Schema.decodeUnknownOption(ReplayDetail)

// OpenRouter's generic Responses API supports chronological effort updates only on eligible models.
export function supportsEffortUpdates(request: LLMRequest) {
  if (request.providerOptions?.truncation === "auto" || request.http?.body?.truncation === "auto") return false
  if (Schema.is(Schema.Struct({ mode: Schema.Literal("pro") }))(request.providerOptions?.reasoning)) return false
  if (Schema.is(Schema.Struct({ mode: Schema.Literal("pro") }))(request.http?.body?.reasoning)) return false
  return (
    request.model.compatibility?.supportsEffortUpdates ?? /^~?openai\/gpt-6-(?:astra|sol|luna)$/i.test(request.model.id)
  )
}

export function nativeRequest(request: LLMRequest, format: "responses" | "messages") {
  const options = request.providerOptions ?? {}
  const reasoning = isRecord(options.reasoning)
    ? fitReasoning(options.reasoning, request.generation?.maxTokens)
    : undefined
  const disabled = reasoning?.enabled === false || reasoning?.effort === "none"
  const updates = resolveEffortUpdates(
    request,
    OpenResponsesOptions.resolve(request).reasoningEffort ??
      (typeof reasoning?.effort === "string" ? reasoning.effort : undefined),
  )
  return LLMRequest.update(request, {
    providerOptions:
      format === "responses"
        ? {
            ...options,
            reasoningEffort: updates.effort,
          }
        : {
            ...options,
            effort:
              options.effort ?? (typeof reasoning?.effort === "string" && !disabled ? reasoning.effort : undefined),
            thinking:
              options.thinking ??
              (() => {
                if (disabled) return { type: "disabled" }
                if (typeof reasoning?.max_tokens === "number")
                  return { type: "enabled", budget_tokens: reasoning.max_tokens }
                if (reasoning?.enabled === true || typeof reasoning?.effort === "string")
                  return { type: "adaptive", ...(reasoning.exclude === true ? { display: "omitted" } : {}) }
              })(),
          },
    messages: (format === "responses" ? updates.request : request).messages.map((message) => {
      if (
        !message.content.some(
          (part) => part.type === "reasoning" && part.providerMetadata?.openrouter?.reasoningDetails !== undefined,
        )
      )
        return message
      return Message.make({
        ...message,
        // Chat stores signatures in reasoning_details; native APIs require individual signed blocks/items.
        content: message.content.flatMap<ContentPart>((part) => {
          if (part.type !== "reasoning") return [part]
          const details = part.providerMetadata?.openrouter?.reasoningDetails
          if (!Array.isArray(details)) return [part]
          const replay = details.flatMap((detail) => Option.toArray(decodeReplayDetail(detail)))
          if (format === "responses") {
            const encrypted = replay.find(
              (detail) => detail.type === "reasoning.encrypted" || detail.type === "encrypted",
            )
            return [
              {
                ...part,
                providerMetadata: {
                  ...part.providerMetadata,
                  openrouter: {
                    ...part.providerMetadata?.openrouter,
                    reasoningEncryptedContent:
                      part.providerMetadata?.openrouter?.reasoningEncryptedContent ??
                      encrypted?.data ??
                      encrypted?.encrypted,
                  },
                },
              },
            ]
          }
          const blocks = replay.flatMap<ReasoningPart>((detail) => {
            if (detail.type === "reasoning.text" && detail.signature)
              return [
                {
                  ...part,
                  text: detail.text ?? part.text,
                  providerMetadata: {
                    ...part.providerMetadata,
                    openrouter: { ...part.providerMetadata?.openrouter, signature: detail.signature },
                  },
                },
              ]
            if (detail.type === "reasoning.encrypted" && detail.data)
              return [
                {
                  ...part,
                  text: "",
                  providerMetadata: {
                    ...part.providerMetadata,
                    openrouter: { ...part.providerMetadata?.openrouter, redactedData: detail.data },
                  },
                },
              ]
            return []
          })
          return blocks.length > 0 ? blocks : [part]
        }),
      })
    }),
  })
}

export function responsesOptions<Body extends Pick<OpenResponses.OpenResponsesBody, "reasoning">>(
  request: LLMRequest,
  body: Body,
) {
  const { usage: _, ...options } = bodyOptions(request.providerOptions, request.generation?.maxTokens)
  return {
    ...options,
    ...body,
    store: false as const,
    // Native lowering may freeze effort at the history baseline; keep it instead of the current effort.
    ...(options.reasoning || body.reasoning ? { reasoning: { ...options.reasoning, ...body.reasoning } } : {}),
  }
}

export const bodyOptions = (input: unknown, maxTokens: number | undefined) => {
  const openrouter = isRecord(input) ? input : {}
  const { usage, models, provider, plugins, web_search_options, debug, user, reasoning, promptCacheKey, ...options } =
    openrouter
  return {
    ...options,
    ...(usage === undefined || usage === true
      ? { usage: { include: true } }
      : usage === false
        ? { usage: { include: false } }
        : isRecord(usage)
          ? { usage }
          : {}),
    ...(Array.isArray(models) ? { models } : {}),
    ...(isRecord(provider) ? { provider } : {}),
    ...(Array.isArray(plugins) ? { plugins } : {}),
    ...(isRecord(web_search_options) ? { web_search_options } : {}),
    ...(isRecord(debug) ? { debug } : {}),
    ...(typeof user === "string" ? { user } : {}),
    ...(isRecord(reasoning) ? { reasoning: fitReasoning(reasoning, maxTokens) } : {}),
  }
}

// Anthropic and Alibaba require the thinking budget to remain below the output limit.
function fitReasoning(reasoning: Record<string, unknown>, maxTokens: number | undefined) {
  return typeof reasoning.max_tokens === "number"
    ? { ...reasoning, max_tokens: ProviderShared.fitThinkingBudget(reasoning.max_tokens, maxTokens, 1_024) }
    : reasoning
}
