#!/usr/bin/env bash
set -euo pipefail

: "${R2_UPDATE_ORIGIN:?Set the public R2 HTTPS origin}"
: "${R2_ACCOUNT_ID:?Set the Cloudflare account ID}"
: "${R2_BUCKET:?Set the R2 bucket name}"
: "${AWS_ACCESS_KEY_ID:?Set the R2 access key ID}"
: "${AWS_SECRET_ACCESS_KEY:?Set the R2 secret access key}"

origin=${R2_UPDATE_ORIGIN%/}
if [[ ! $origin =~ ^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ || ! $R2_ACCOUNT_ID =~ ^[0-9a-f]{32}$ ]]; then
  echo 'Invalid R2 update origin or Cloudflare account ID.' >&2
  exit 1
fi

cd "${1:?Pass the verified updates directory}"
read -r tag digest < <(python3 -c 'import json; x = json.load(open("latest.json", encoding="utf-8")); print(x["tag"], x["sha256"])')
if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ || ! $digest =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Invalid update manifest.' >&2
  exit 1
fi
apk="deepseek-api-$tag.apk"
sha256sum --check <<< "$digest  $apk"

put() {
  aws --no-cli-pager --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" s3api put-object \
    --bucket "$R2_BUCKET" --key "updates/$1" --body "$1" --content-type "$2" \
    --cache-control "$3" --storage-class STANDARD >/dev/null
}

# Publish the manifest only after the new APK is reachable and correct on the public origin.
put "$apk" application/vnd.android.package-archive 'public, max-age=31536000, immutable'
curl --fail --silent --show-error --proto '=https' --max-time 45 --retry 2 "$origin/updates/$apk" |
  sha256sum --check <(printf '%s  -\n' "$digest")
put reasoning-aliases.json application/json 'public, max-age=300, must-revalidate'
put latest.json application/json 'public, max-age=60, must-revalidate'
