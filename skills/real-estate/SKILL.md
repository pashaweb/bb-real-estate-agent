---
name: real-estate
description: Score an Idealista property listing as a buy-to-let investment, and have a chosen model second-guess the score. Use when the user shares an idealista.com URL, asks whether a flat is a good buy, or asks about Oviedo districts, rental yield or what to offer.
---

# Scoring property listings

Idealista blocks non-browser clients (403 from DataDome), so never try to fetch
an idealista.com URL directly. Use this plugin — it reads the page through a
real Chrome on the user's machine.

## Commands

```bash
bb real-estate models                      # models available to evaluate with
bb real-estate use-model <model-id>        # choose one
bb real-estate add <idealista-url>         # read, score, and evaluate
bb real-estate list                        # shortlist, best first
bb real-estate show <id>                   # full breakdown
bb real-estate evaluate <id> --model <id>  # re-ask, or ask a different model
```

`add` accepts `--no-ai` to score without spending a model turn, and `--model
<id>` to override the configured model for that run.

## What the score means

Two numbers, deliberately kept apart:

- **score** — deterministic, from district €/m² and rent benchmarks, yield,
  building quality and risk flags (judicial auction, *renta antigua*, sitting
  tenant, buyer-paid agency fees). It never varies between runs.
- **model** — a chosen provider model arguing with that score. It is asked to
  disagree and to say what it would pay.

When they diverge, say so and explain which input drives the gap rather than
averaging them.

## Never evaluate from inside an evaluation

If your prompt already contains a listing's facts and a score to challenge, you
are the evaluation. Answer from what you were given. Do not call
`real_estate_score_listing` or `bb real-estate` — that scrapes the listing again
and spawns another evaluation thread, which does the same.

`add` and the tool only spend a model turn when asked: the tool's `askModel`
defaults to false, so a plain score costs nothing.

## Cautions

- District figures are dated benchmarks and some are explicitly marked as
  estimates; the breakdown says which. Repeat that caveat rather than
  presenting a score as a valuation.
- The first run on a fresh Chrome profile usually hits a bot challenge. The
  command says so and leaves the tab open for the user to solve by hand.
- Always surface the "Before you offer" checklist — ITE, community debts,
  derramas, cadastral surface, the actual rental contract. That is where the
  real answers are, not in the score.
