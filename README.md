# bb-plugin-real-estate-agent

A BB plugin that reads an Idealista property listing, scores it as a buy-to-let
investment, and then has **a model you choose** argue with that score.

```bash
bb real-estate models                      # every model BB can reach
bb real-estate use-model sonnet            # pick one (substring is enough)
bb real-estate add <idealista-url>         # read, score, evaluate
bb real-estate list                        # shortlist, best first
bb real-estate show <id>                   # full breakdown
bb real-estate evaluate <id> --model haiku # re-ask, or ask a different model
```

## The Listings panel

`app.slots.navPanel` gives the plugin its own sidebar entry and owns the route
`/plugins/real-estate-agent/listings`: an add form, the ranked table (local
score, model score, verdict and risk pills, price, €/m², vs-area, lift, heat,
rent, yield, fair price — every column sortable), and a detail dialog with the
score bars, risks, economics, price ladder and pre-offer checklist.

It talks to the backend over `bb.rpc` rather than HTTP, so there is no port and
the calls are typed end-to-end from one shared contract. The server publishes a
`listings-changed` signal after every write, and the panel subscribes with
`useRealtime`, so a listing added from the CLI or by an agent appears in an open
panel immediately. Styling uses BB's theme tokens, so it follows whatever theme
you are on.

## Importing from the standalone app

This plugin grew out of a standalone local app with its own SQLite. To bring
that data across:

```bash
bb real-estate import ~/Personal/real-estate-agent/data/listings.db
```

Manual corrections stored there win over the scraped fields, exactly as they did
in that app, and any pasted second opinion is kept as an `imported/chatgpt`
verdict. Scores are recomputed with this plugin's config rather than copied. The
file is read on the machine that invoked the command, through the host entry.

## Choosing the evaluation model

`providers.models` is per-provider — called without a `providerId` it answers
nothing — so the plugin asks every *available* provider and merges the results
into one list. Model ids are only unique within a provider, so they are shown
and stored provider-qualified:

```
  claude-code/claude-fable-5-1               Fable 5.1
· claude-code/claude-opus-5[1m]              Opus 5 (1M)
* claude-code/claude-sonnet-5                Sonnet 5
  claude-code/claude-haiku-4-5-20251001      Haiku

* = selected   · = BB default (used when none selected)
```

`use-model` takes a full id or any unambiguous substring; an ambiguous one is
refused with the candidates rather than guessed at. With nothing selected the
plugin uses BB's default model. `--model` overrides per run.

The evaluation itself runs as a hidden thread spawned with that model and
provider, so anything BB can talk to can serve it — no separate API key, and no
provider-specific code here.

## Two numbers, deliberately kept apart

- **score** — deterministic, computed here: district €/m² and rent benchmarks,
  gross yield, building quality, and risk flags (judicial auction, *renta
  antigua*, sitting tenant, buyer-paid agency fees). Identical between runs.
- **model** — the chosen model, handed the listing *and this plugin's working*,
  asked to disagree and say what it would pay.

Both are shown side by side. When they diverge, the gap is the interesting part.

## Reading the page

Idealista answers non-browser clients with `403` (DataDome), so the listing is
read through a real Chrome over the DevTools Protocol. That lives in `host.ts`,
the full-trust host entry, and is routed to the **invoking machine's** host id —
a CLI command runs on the server, which on an enrolled remote machine is not
where the user's browser profile lives.

The first run on a fresh profile usually hits a bot challenge. The command says
so and leaves the tab open for you to solve; the profile
(`~/.bb-real-estate-agent/chrome-profile` by default) keeps the cookie.

## Settings

| Setting | Default | |
|---|---|---|
| Evaluation model | *(blank)* | provider-qualified id; blank uses BB's default |
| Project for evaluation threads | *(blank)* | where hidden threads are spawned; falls back to the calling thread's project |
| Ask the model automatically | on | run an evaluation on `add` |
| Chrome DevTools port | 9222 | attach here, or launch Chrome on it |
| Chrome binary | *(blank)* | autodetects Chrome, Chromium, Brave |
| Chrome profile directory | *(blank)* | `~/.bb-real-estate-agent/chrome-profile` |

## Scoring config

`config/oviedo.json` holds the district benchmarks, dimension weights, risk
penalties and cost rates. Districts came from a research session on Oviedo
neighbourhoods; four are marked `"estimated": true` because they were not in it,
and any listing scored against one says so in its notes. An unrecognised Oviedo
district falls back to a city average, also flagged.

These figures go stale. Treat a score as a shortlisting aid, not a valuation —
the "Before you offer" checklist (ITE, community debts, derramas, cadastral
surface, the actual rental contract) is where the real answers are.

## Layout

```
app.tsx              the Listings panel: add form, ranked table, sorting
components/          listing-detail.tsx, plus BB's vendored ui/ primitives
lib/format.ts        shared currency/score formatting
server.ts            settings, storage, model resolution, RPC, CLI, agent tool
host.ts              full-trust entry — the only place that drives Chrome
contract.ts          the RPC contract shared by the two
src/cdp.ts           Chrome DevTools Protocol client
src/parse.ts         Idealista page text -> structured fields
src/score.ts         the deterministic scorer
src/prompt.ts        the evaluation prompt, and the score parsed back out
config/oviedo.json   districts, weights, penalties — the tunable part
skills/real-estate/  how agents should use the commands
```

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run build        # bb plugin build
bb plugin install .  # register this directory
bb plugin dev        # rebuild + reload on save
```

The agent tool `real_estate_score_listing` exposes the same pipeline to agents
in a thread.
