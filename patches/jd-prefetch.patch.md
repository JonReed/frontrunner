# Patch: populate the batch runner's JD file from `jds/`

**Why:** `batch/batch-runner.sh` creates an EMPTY temp file per offer and passes it
as `{{JD_FILE}}`. Nothing writes to it, so every worker falls through to
`batch-prompt.md` step 1 and WebFetches the full HTML page.
Measured: ~18,000 tokens of rendered page to obtain a ~1,800-token JD. **9.9x waste.**

**`batch/batch-runner.sh` is in `update-system.mjs` SYSTEM_PATHS**, so this edit is
overwritten by `node update-system.mjs apply`. Re-apply it afterwards.

In `process_offer()`, immediately after:

    jd_file="$(mktemp "${TMPDIR:-/tmp}/batch-jd-${id}.XXXXXX")"

insert:

```bash
  local jd_index="$PROJECT_DIR/jds/index.tsv"
  if [[ -f "$jd_index" ]]; then
    local cached_jd
    cached_jd="$(awk -F'\t' -v u="$url" '$1==u{print $2; exit}' "$jd_index")"
    if [[ -n "$cached_jd" && -s "$cached_jd" ]]; then
      cat "$cached_jd" > "$jd_file"
      echo "    📄 JD pre-fetched ($(wc -c < "$jd_file" | tr -d ' ') bytes) — no WebFetch needed"
    fi
  fi
```

Verify with `bash -n batch/batch-runner.sh`, then confirm a worker logs
"JD pre-fetched" rather than fetching the URL.
