#!/usr/bin/env python3
"""Validate an agent pack against schemas/agent-pack.schema.json.

Usage: scripts/validate-agent-pack.py <pack.yaml> [VAR=value ...]
Placeholders ${VAR} / ${VAR:-default} are resolved from the given VAR=value pairs,
then from the process environment, then from the default. Requires: pyyaml, jsonschema.
"""
import json, os, re, sys
import yaml, jsonschema

PH = re.compile(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}")

def coerce(s):
    if re.fullmatch(r"-?\d+", s): return int(s)
    if re.fullmatch(r"-?\d+\.\d+", s): return float(s)
    if s in ("true", "false"): return s == "true"
    return s

def resolve(x, env):
    if isinstance(x, dict): return {k: resolve(v, env) for k, v in x.items()}
    if isinstance(x, list): return [resolve(v, env) for v in x]
    if isinstance(x, str):
        def sub(m):
            var, dflt = m.group(1), m.group(2)
            if var in env: return env[var]
            if dflt is not None: return dflt
            sys.exit(f"unresolved placeholder ${{{var}}}")
        out = PH.sub(sub, x)
        return coerce(out) if PH.fullmatch(x) else out
    return x

def cross_field(doc):
    ident = doc["identity"]; roles = set(ident.get("roles", {}))
    homes = [r for r in ident["recognizedBackingIdentities"] if r["relation"] == "home"]
    assert len(homes) == 1 and homes[0]["identity"] == ident["homeBackingIdentity"], "rule 1: one home entry equal to homeBackingIdentity"
    used = set()
    for r in ident["roleRules"]: used |= set(r["roles"])
    for r in ident.get("perActorOverrides", []): used |= set(r["roles"])
    def access(t):
        for k in (t.get("roles") or {}): used.add(k)
        for a in t.get("approval", []) + t.get("elevation", []):
            used |= set(a["approvers"])
            for ap in a["approvers"]:
                assert ident.get("roles", {}).get(ap, {}).get("canApprove"), f"rule 3: approver role {ap} lacks canApprove"
    access(doc.get("tools", {}).get("access", {}))
    for s in doc.get("mcp", {}).get("servers", []): access(s.get("toolAccess", {}))
    for p in doc.get("purposes", []): used |= set(p.get("permittedRoles", []))
    for m in doc["persona"].get("menu", []): used |= set(m.get("roles", []))
    assert used <= roles, f"rule 2: undeclared roles {sorted(used - roles)}"
    pids = {p["id"] for p in doc.get("purposes", [])}
    for s in doc.get("mcp", {}).get("servers", []):
        for e in s.get("toolAccess", {}).get("elevation", []):
            assert set(e["purposes"]) <= pids, f"rule 4: unknown purposes {set(e['purposes']) - pids}"
    for name, a in doc.get("actions", {}).items():
        if a.get("authChallenge", {}).get("type") == "face-match":
            assert "faceVerification" in doc.get("media", {}), f"rule 6: {name} needs media.faceVerification"
    f = doc.get("features", {})
    assert not f.get("rag") or "rag" in doc, "rule 7: features.rag needs rag"
    assert not f.get("voiceNotes") or "speechToText" in doc.get("media", {}), "rule 7: voiceNotes needs media.speechToText"
    assert not f.get("inboundImages") or "vision" in doc.get("media", {}), "rule 7: inboundImages needs media.vision"
    assert not f.get("imageGeneration") or "imageGeneration" in doc.get("media", {}), "rule 7: imageGeneration needs media.imageGeneration"
    w = doc.get("channels", {}).get("agui", {}).get("walletLinkTemplate", "https://x/{oob}")
    assert w.startswith("https://") and "{oob}" in w, "rule 9: walletLinkTemplate"

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    env = dict(os.environ)
    env.update(kv.split("=", 1) for kv in sys.argv[2:])
    here = os.path.dirname(os.path.abspath(__file__))
    schema = json.load(open(os.path.join(here, "..", "schemas", "agent-pack.schema.json")))
    doc = resolve(yaml.safe_load(open(sys.argv[1])), env)
    jsonschema.Draft202012Validator.check_schema(schema)
    errs = sorted(jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).iter_errors(doc), key=lambda e: list(e.path))
    for e in errs: print(f"schema: {'/'.join(map(str, e.path)) or '<root>'}: {e.message}")
    if errs: sys.exit(1)
    cross_field(doc)
    print("ok:", sys.argv[1])

if __name__ == "__main__":
    main()
