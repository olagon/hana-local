#!/usr/bin/env bash
# Rebuilds the bundled default model (Qwen2.5 3B, q4f16_1, about 1.7 GB)
# into models/ so hana-local serves it from its own origin with no CDN
# involved. Safe to re-run: it verifies every shard against
# ndarray-cache.json and re-downloads only what is missing or truncated.
set -euo pipefail

REPO="mlc-ai/Qwen2.5-3B-Instruct-q4f16_1-MLC"
DEST="$(cd "$(dirname "$0")" && pwd)/models/Qwen2.5-3B-Instruct-q4f16_1-MLC/resolve/main"
LIBS="$(cd "$(dirname "$0")" && pwd)/models/libs"
WASM_URL="https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm"

mkdir -p "$DEST" "$LIBS"
cd "$DEST"

echo "Listing files in $REPO ..."
FILES=$(curl -sfL "https://huggingface.co/api/models/$REPO" |
  python3 -c "import json,sys; [print(s['rfilename']) for s in json.load(sys.stdin)['siblings'] if s['rfilename'] not in ('.gitattributes','README.md')]")

echo "Downloading $(echo "$FILES" | wc -l | tr -d ' ') files ..."
echo "$FILES" | xargs -P 4 -I {} sh -c \
  'test -s "{}" || curl -sfL --retry 5 --retry-delay 3 -o "{}" "https://huggingface.co/'"$REPO"'/resolve/main/{}"'

echo "Verifying shard sizes ..."
python3 - <<'EOF'
import json, os, subprocess, sys

repo = "mlc-ai/Qwen2.5-3B-Instruct-q4f16_1-MLC"
meta = json.load(open("ndarray-cache.json"))
for attempt in range(3):
    bad = [r["dataPath"] for r in meta["records"]
           if (os.path.getsize(r["dataPath"]) if os.path.exists(r["dataPath"]) else -1) != r["nbytes"]]
    if not bad:
        print("All shards verified.")
        sys.exit(0)
    print(f"Re-downloading {len(bad)} incomplete shard(s), pass {attempt + 1} ...")
    for p in bad:
        subprocess.run(["curl", "-sfL", "--retry", "5", "--retry-delay", "3", "-o", p,
                        f"https://huggingface.co/{repo}/resolve/main/{p}"], check=False)
print("Some shards are still incomplete. Re-run this script to resume.", file=sys.stderr)
sys.exit(1)
EOF

echo "Fetching WebGPU wasm library ..."
curl -sfL --retry 5 -o "$LIBS/Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm" "$WASM_URL"

echo "Done. hana-local will now serve the default model from its own origin."
