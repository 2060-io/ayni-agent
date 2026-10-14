# Local VS Agent for development

The Ayni Agent delegates DIDComm, credentials and trust resolution to a VS Agent (spec:
Verifiable Trust v4-compliant DIDComm agent). This directory runs one locally, in standalone mode,
registered on the Verana **devnet** (v4). The testnet moves to v4 on 13 October 2026; switching is a
matter of changing the four network values in `.env` and redoing the bootstrap there.

## What is in here

| File | Role |
|------|------|
| `docker-compose.yml` | VS Agent + PostgreSQL + Redis. Admin API on `127.0.0.1:3010`, public API on `127.0.0.1:3011` (exposed through ngrok) |
| `.env.example` | Every variable the agent needs; copy to `.env`, which is git-ignored and holds the mnemonic |
| `bootstrap.sh` | The registry side with `veranad`: account and faucet, corporation and operator grant, corporation DID, ECS onboarding |
| `../tools/faucet.mjs` | Faucet client (ADR-036 signature from the mnemonic) |
| `../tools/build-vs-agent-image.sh` | Builds a native image from the vs-agent sources; the published images are amd64-only |

## Procedure

1. **Tunnel.** `ngrok http 3011` and note the `https://…` URL. The agent derives its DID from it on
   first start, so the URL must not change afterwards (a reserved ngrok domain is strongly advised).
2. **Accounts.** `bootstrap.sh key` creates two keys in keyring `test`, saves their mnemonics under
   `~/.config/ayni-agent-dev/` and funds both from the faucet (50 VNA per account per hour):
   `ayni-agent` signs the registry transactions as corporation operator; `ayni-agent-vs` is
   the agent's own account (`VERANA_ACCOUNT_MNEMONIC`, the `vs_operator`). The chain refuses one
   account holding both an operator authorization and a vs_operator authorization.
3. **Corporation.** `bootstrap.sh corp did:web:<ngrok host> <governance document URL>` creates the
   corporation (one member, threshold 1) and, through a one-member group proposal executed at once,
   grants the account an operator authorization for the participant messages. The id and policy
   address are saved for the next steps. The DID is a placeholder until the agent exists.
4. **Agent.** Fill `.env` (corporation id, mnemonic, public URL, claims) and `docker compose up -d`.
   Wait for `GET http://127.0.0.1:3010/v2/agent/health/ready` to answer 200, then read the DID from
   `GET /v2/agent/info`.
5. **DID.** `bootstrap.sh did <agent DID>` points the corporation at the agent's DID.
6. **Onboarding.** `bootstrap.sh onboard <agent DID>` starts the HOLDER onboarding process on the
   ECS Organization schema (validator: the devnet ECS organization issuer, participant 7) and
   self-creates the ISSUER participant on the ECS Service schema (root participant 3), both with
   the agent account as `vs_operator` and the message types the VPR permits per role (HOLDER:
   TriggerResolver; ISSUER: CreateOrUpdateParticipantSession). The agent sees both through the indexer, runs the onboarding
   over DIDComm, receives the Organization credential, issues its Service credential to itself and
   publishes both as linked presentations.
7. **Check.** `bootstrap.sh status <agent DID>` and `curl https://<host>/.well-known/did.json`.

## Devnet facts used

| Item | Value |
|------|-------|
| ECS ecosystem | id 1, `did:webvh:QmQueP3dCakEphRR694eYzZEhF53FvzPCPrdoHK3aMeFKh:ecs-ecosystem.devnet.verana.network` |
| ECS Organization schema | id 1, holder onboarding = ISSUER_ONBOARDING_PROCESS, validator participant 7 (`ecs-org-issuer.devnet.verana.network`, zero fees) |
| ECS Service schema | id 3, issuer onboarding OPEN, root participant 3 |
| Faucet | `https://faucet.devnet.verana.network` (challenge, token, dispense) |

## Notes

- The Admin API is unprotected and bound to loopback; the Ayni Agent reaches it at
  `http://127.0.0.1:3010` (in Compose: `http://vs-agent:3000`). Never publish port 3000.
- `EVENTS_WEBHOOK_URL` points at the Ayni Agent's events endpoint once it runs.
- A fresh DID means redoing steps 5 and 6: wipe the `agent-data` volume only on purpose.

## State of the development instance (13 October 2026)

| Item | Value |
|------|-------|
| Public URL | `https://moonlit-trowel-unedited.ngrok-free.dev` (free ngrok domain; a reserved domain is needed for durability) |
| Agent DID | `did:webvh:QmPk9gWBYyz93N8odMFuTpSS1yMPJhPpKynNwQw1oxjiqf:moonlit-trowel-unedited.ngrok-free.dev` |
| Corporation | id 33, policy `verana10qtgwuea5kfmcyuvtpygqzgfz5fuv5qny6xsksfglhgyta2jc38sct5wad` |
| Operator account | `verana1eh0dne3gma5dla68v0askxjc4vn2jpfmsamhm4` (`ayni-agent`) |
| Agent account | `verana1gr5y56futaeeu2ea45p6dykl82h04pcawwjavu` (`ayni-agent-vs`) |
| ECS Service | ISSUER participant 156 active; Service credential self-issued, digest anchored, linked presentation published |
| ECS Organization | HOLDER participant 155, onboarding process pending on the validator side (participant 7, `ecs-org-issuer.devnet.verana.network`) |
| Image | `vs-agent:local-arm64`, built from `verana-labs/vs-agent` `ee6417b` (origin/main, the `v2.0.0-dev.91` line) |
