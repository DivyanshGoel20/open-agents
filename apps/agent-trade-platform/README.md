# Agent Trade Platform

iMessage-style **conversation UI** plus **autonomous Uniswap quotes** on **Base Sepolia (84532)**.

- **AXL**: Each agent runs a **gensyn-ai/axl** `node`; the platform hits `/send`, `/topology`, `/recv` (see `../../axl/LLM.md`). **`DEMO_MODE=true`** disables real HTTP calls to nodes (demo only).

## What you must have running locally

Two `node` processes with distinct **`api_port`** values (typically **Alice `9002`**, **Bob `9012`**), peered together. Align **`AGENT_ALICE_API`** / **`AGENT_BOB_API`** in `.env` with those URLs. No `DEMO_MODE` unless you explicitly want sandbox mode.

- **Inference (pick one)**

  **OpenAI-compatible router (Integrate-hosted Qwen, etc.):** set **`0G_API_KEY`** and **`ZERO_G_ROUTER_BASE_URL`** at the documented OpenAI-compat root (typically ends in **`/v1`** — Integrate dashboards often expose **`…/openapi/v1`**). Optionally **`ZERO_G_ROUTER_MODEL`**. Uses the **`openai`** npm client (`chat.completions.create` with **`stream: false`**). No wallet and no decentralized **`processResponse`**.

  **0G serving broker:** per-agent **`ALICE_PRIVATE_KEY` / `BOB_PRIVATE_KEY`** + **`ALICE_PROVIDER_ADDRESS` / `BOB_PROVIDER_ADDRESS`**; **`processResponse` after every completion** remains required (see `.0g-compute-skills/SKILL.md`).

  **`ZERO_G_CHAT_BACKEND`:** `broker` forces the broker even if `0G_API_KEY` + base URL exist; **`router`** forces router (errors if missing base URL/key).

  If router env vars are satisfied and **`ZERO_G_CHAT_BACKEND` ≠ `broker`**, the **router wins**.

- **Per-agent EVM keys (quotes)**  
  **`ALICE_PRIVATE_KEY` / `BOB_PRIVATE_KEY`** — used to derive a `swapper` address for Trading API quotes. No approvals and no transactions are sent.

- **Quotes**: Trading API **`quote`** only (no approvals, no swap endpoint, no broadcast).

## Commands

```bash
cd apps/agent-trade-platform
cp .env.example .env   # edit keys
npm install
npm run dev
```

API: `http://127.0.0.1:8787` • UI (proxy): `http://127.0.0.1:5173`  

## How this runs

`npm run dev` runs **`dev:server`** (Express on **8787**) and **`wait-on tcp:127.0.0.1:8787 && dev:web`**, so **Vite starts only after** the API socket is open. That removes the usual burst of proxy **`ECONNREFUSED`** during cold start. Logs: **`[0]`** = API, **`[1]`** = UI.

- API only: `npm run dev:server`
- UI only: `npm run dev:web` (expects something on `8787`, or you will see `/api` errors)

With **`DEMO_MODE` off**, the UI **polls `/api/axl/ingest` every ~3 seconds** so deliveries show quickly. **`POST /api/axl/send`** (buttons **Send Alice / Send Bob**) tags **`origin:'human'`**; when the peer’s node ingests it, **`AXL_AUTO_REPLY`** (default on) runs **0G/Qwen as the inbox owner**, then **`/send`**s back tagged **`origin:'auto'`** (no reciprocal auto‑reply, so loops stay quiet unless you deliberately send human again).

**Pull AXL now** forces an ingest without waiting for the timer.

## Troubleshooting

**`[Alice] 0G offline` … `404 page not found`**  
Router mode calls **`{ZERO_G_ROUTER_BASE_URL}/chat/completions`**. Integrate-style hosts often need **`…/openapi/v1`** (not only **`…/v1`**). Open **`http://127.0.0.1:8787/api/debug/inference`** while the API runs to see **`completionsUrls`** the server will try.

**`SyntaxError` from `@0glabs/0g-serving-broker` (missing export `C`, etc.)**  
We load the broker with **`createRequire` → CommonJS**. Ensure you have the latest `server/ogChat.ts` and run `npm install` here.

**`[vite] http proxy error … ECONNREFUSED`**  
Usually the API exited or never bound **8787** (see **`[0]`** logs): crash on startup, or port already in use. The API listens on **`127.0.0.1`** to match Vite’s proxy target. Fix the crash / free the port (/ change **`PORT`** + **`vite.config.ts`** proxy together).

## QUOTE_JSON

When the agent wants a quote, it appends a single trailing line like:

`QUOTE_JSON:{"tokenIn":"0x...","tokenOut":"0x...","amount":"100000000000000000"}`
