import { expect } from "bun:test"
import { Effect } from "effect"
import { LLMEvent, LLMResponse } from "../../src/index.js"
import { OpenRouter } from "../../src/providers/openrouter.js"
import { recordedTests } from "../recorded-test.js"
import { expectWeatherToolLoop, goldenWeatherToolLoopRequest, runWeatherToolLoop } from "../recorded-scenarios.js"

const recorded = recordedTests({
  prefix: "openrouter-responses",
  provider: "openrouter",
  protocol: "openrouter-responses",
  requires: ["OPENROUTER_API_KEY"],
})

recorded.effect.with(
  "continues Meta reasoning through a tool loop",
  { cassette: "openrouter-responses/openrouter-muse-spark-1-3-tool-loop", tags: ["reasoning", "tool-loop"] },
  () =>
    Effect.gen(function* () {
      const events = yield* runWeatherToolLoop(
        goldenWeatherToolLoopRequest({
          model: OpenRouter.configure({
            apiKey: process.env.OPENROUTER_API_KEY ?? "fixture",
            providerOptions: { reasoning: { effort: "minimal" } },
          }).model("meta/muse-spark-1.3"),
          maxTokens: 512,
        }),
      )

      expectWeatherToolLoop(events)
      expect(LLMResponse.text({ events: events.slice(events.findIndex(LLMEvent.is.stepFinish) + 1) }).trim()).toMatch(
        /^Paris is sunny\.?$/,
      )
    }),
  60_000,
)
