#!/usr/bin/env bash
# =============================================================================
# Local VS Agent on the Verana devnet: on-chain bootstrap for the development agent.
# =============================================================================
# Runs the registry side of the VS Agent v4 standalone mode (verana-spec v4/vs-agent,
# VSA-VTI-ECS-STANDALONE) with the veranad CLI, so no browser wallet is needed:
#
#   key        create two accounts (keyring "test") and fund them through the faucet:
#              KEY_NAME        the corporation operator (signs the registry transactions here)
#              KEY_NAME-vs     the agent's own account (VERANA_ACCOUNT_MNEMONIC, the vs_operator);
#              the chain refuses one account in both roles
#   corp       create the corporation (one member, threshold 1) and grant the operator account an
#              operator authorization for the delegable participant messages
#   did        after the agent's first start: set the corporation DID to the agent's DID
#   onboard    HOLDER onboarding on the ECS Organization schema (validator: ECS org issuer)
#              and ISSUER self-creation on the ECS Service schema, both with the agent's
#              account as vs_operator (HOLDER: TriggerResolver; ISSUER:
#              CreateOrUpdateParticipantSession, the message types the VPR permits per role);
#              the agent then runs the DIDComm flows by itself
#   status     show corporation, participants and the indexer's trust verdict
#
# Usage: dev/vs-agent/bootstrap.sh <step> [args]     (see each step for arguments)
# Needs: veranad >= v0.10.6 (v4 modules co/pp/de; VERANAD=... to point at it), jq, curl, node.
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG_DIR="${HOLOGRAM_DEV_CFG:-$HOME/.config/hologram-agent-dev}"
VERANAD="${VERANAD:-veranad}"
KEY="${KEY_NAME:-hologram-agent}"
NETWORK="${NETWORK:-devnet}"
case "$NETWORK" in
  devnet)  CHAIN_ID=vna-devnet-1;  RPC=https://rpc.devnet.verana.network;  IDX=https://idx.devnet.verana.network;  FAUCET=https://faucet.devnet.verana.network ;;
  testnet) CHAIN_ID=vna-testnet-1; RPC=https://rpc.testnet.verana.network; IDX=https://idx.testnet.verana.network; FAUCET=https://faucet.testnet.verana.network ;;
  *) echo "unknown NETWORK $NETWORK" >&2; exit 1 ;;
esac
TXF=(--from "$KEY" --keyring-backend test --chain-id "$CHAIN_ID" --node "$RPC" --gas auto --gas-adjustment 1.6 --gas-prices 1uvna --output json -y)
STATE="$CFG_DIR/$NETWORK.env"            # corporation id and policy address, written by `corp`
mkdir -p "$CFG_DIR"; chmod 700 "$CFG_DIR"
[ -f "$STATE" ] && source "$STATE"

addr() { "$VERANAD" keys show "$KEY" -a --keyring-backend test; }
vsaddr() { "$VERANAD" keys show "$KEY-vs" -a --keyring-backend test; }
fund() {  # fund <key name> [amount]
  ( cd "$HERE/../tools" && { [ -d node_modules ] || npm install --silent >/dev/null; } )
  node "$HERE/../tools/faucet.mjs" "$FAUCET" "$(jq -r .mnemonic "$CFG_DIR/$1-key.json")" "${2:-50000000}" | cut -c1-160
}
tx() {  # tx <event-type> <args...> : broadcast, wait, print the event's attributes as JSON
  local ev=$1; shift
  local out hash
  out=$("$VERANAD" tx "$@" "${TXF[@]}" 2>&1) || { echo "$out" >&2; return 1; }
  hash=$(echo "$out" | grep -E '^\{' | jq -r .txhash)
  [ -n "$hash" ] || { echo "$out" >&2; return 1; }
  sleep 7
  "$VERANAD" q tx "$hash" --node "$RPC" --output json | jq -c --arg ev "$ev" '.code as $c | (.events[] | select(.type==$ev) | [.attributes[] | {(.key): .value}] | add) // {code:$c, raw_log:.raw_log}'
}

case "${1:-}" in
  key)
    for k in "$KEY" "$KEY-vs"; do
      if ! "$VERANAD" keys show "$k" --keyring-backend test >/dev/null 2>&1; then
        "$VERANAD" keys add "$k" --keyring-backend test --output json > "$CFG_DIR/$k-key.json"; chmod 600 "$CFG_DIR/$k-key.json"
        echo "created $k; mnemonic in $CFG_DIR/$k-key.json"
      fi
      echo "$k: $("$VERANAD" keys show "$k" -a --keyring-backend test)"; fund "$k" "${2:-50000000}"
    done
    sleep 6; for k in "$KEY" "$KEY-vs"; do echo "$k balance: $("$VERANAD" q bank balances "$("$VERANAD" keys show "$k" -a --keyring-backend test)" --node "$RPC" --output json | jq -c .balances)"; done
    echo "put the $KEY-vs mnemonic in .env as VERANA_ACCOUNT_MNEMONIC" ;;

  corp)   # corp <placeholder-did> <gov-doc-url>
    DID="${2:?placeholder DID, e.g. did:web:<public host>}"; DOC="${3:?governance document URL}"
    SRI="sha256-$(curl -sfL "$DOC" | openssl dgst -sha256 -binary | base64)"
    ev=$(tx create_corporation co create-corporation --did "$DID" --language en --doc-url "$DOC" --doc-digest-sri "$SRI" \
         --members "{\"address\":\"$(addr)\",\"weight\":\"1\",\"metadata\":\"\"}" \
         --decision-policy '{"@type":"/cosmos.group.v1.ThresholdDecisionPolicy","threshold":"1","windows":{"voting_period":"60s","min_execution_period":"0s"}}')
    echo "$ev"; CORP_ID=$(echo "$ev" | jq -r .corporation_id); POLICY=$(echo "$ev" | jq -r .policy_address)
    printf 'CORP_ID=%s\nPOLICY=%s\n' "$CORP_ID" "$POLICY" > "$STATE"
    TYPES=/verana.co.v1.MsgUpdateCorporation,/verana.pp.v1.MsgStartParticipantOP,/verana.pp.v1.MsgRenewParticipantOP,/verana.pp.v1.MsgCancelParticipantOPLastRequest,/verana.pp.v1.MsgSelfCreateParticipant,/verana.pp.v1.MsgTriggerResolver,/verana.pp.v1.MsgRevokeParticipant,/verana.pp.v1.MsgSetParticipantEffectiveUntil
    MSG=$("$VERANAD" tx de grant-operator-authz "$(addr)" --corporation "$POLICY" --msg-types "$TYPES" --from "$POLICY" --generate-only --offline --account-number 0 --sequence 0 --keyring-backend test | jq -c '.body.messages[0]')
    P=$(mktemp); jq -n --arg p "$POLICY" --arg a "$(addr)" --argjson m "$MSG" '{group_policy_address:$p, messages:[$m], metadata:"", title:"Operator authorization for the agent account", summary:"dev", proposers:[$a]}' > "$P"
    tx grant_operator_authorization group submit-proposal "$P" --exec try; rm -f "$P"
    echo "corporation $CORP_ID, policy $POLICY (saved to $STATE)" ;;

  did)    # did <agent did>  (read it from GET /v2/agent/info)
    tx update_corporation co update-corporation --corporation "$POLICY" --did "${2:?agent DID}" ;;

  onboard)  # onboard <agent did> [org-validator-participant-id] [service-root-participant-id]
    DID="${2:?agent DID}"; ORG_VALIDATOR="${3:-7}"; SVC_ROOT="${4:-3}"
    echo "HOLDER onboarding on the ECS Organization schema, validator participant $ORG_VALIDATOR"
    tx start_participant_op pp start-participant-op holder "$ORG_VALIDATOR" "$DID" --corporation "$POLICY" \
       --vs-operator "$(vsaddr)" --vs-operator-authz-msg-types /verana.pp.v1.MsgTriggerResolver
    echo "ISSUER self-creation on the ECS Service schema, root participant $SVC_ROOT"
    tx self_create_participant pp self-create-participant issuer "$SVC_ROOT" "$DID" --corporation "$POLICY" \
       --vs-operator "$(vsaddr)" --vs-operator-authz-msg-types /verana.pp.v1.MsgCreateOrUpdateParticipantSession ;;

  status)
    echo "corporation:"; curl -s "$IDX/v4/corporation/get/${CORP_ID:?run corp first}" | jq -c '.corporation | {id, did, policy_address}'
    echo "participants:"; curl -s "$IDX/v4/participant/list?corporation_id=$CORP_ID&limit=20" | jq -c '.participants[]? | {id, schema_id, role, participant_state, op_state, vs_operator}'
    [ -n "${2:-}" ] && { echo "trust:"; curl -s -X POST "$IDX/v4/verifiable-trust/resolve" -H 'content-type: application/json' -d "{\"did\":\"$2\"}" | head -c 800; echo; } ;;

  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
