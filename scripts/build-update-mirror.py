"""Create a Pages artifact using only this repository's latest stable APK."""

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

REPOSITORY = "dhz1145/deepseek-api"
TAG = re.compile(r"v(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}")
MAX_APK = 256 * 1024 * 1024


def release_asset(release):
    tag = release["tag_name"]
    if release["draft"] or release["prerelease"] or not TAG.fullmatch(tag):
        raise ValueError("Latest release is not a stable Android version")
    name = f"deepseek-api-{tag}.apk"
    url = f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}"
    (asset,) = [item for item in release["assets"] if item["name"] == name]
    if (
        asset["state"] != "uploaded"
        or asset["browser_download_url"] != url
        or not 0 < asset["size"] <= MAX_APK
        or asset["id"] <= 0
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", asset.get("digest") or "")
    ):
        raise ValueError("Latest release has no verifiable APK")
    return name, {
        "schema": 1,
        "tag": tag,
        "size": asset["size"],
        "sha256": asset["digest"][len("sha256:"):],
        "assetId": asset["id"],
    }


def main(site):
    release = json.loads(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/releases/latest"]))
    name, manifest = release_asset(release)
    # Pages identifies deployments by commit SHA. Do not deploy an older release
    # from the commit reserved for a newer APK before that release is published.
    source_version = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text(encoding="utf-8"))["version"]
    if manifest["tag"] != f"v{source_version}":
        raise ValueError(f"Workflow source v{source_version} does not match latest Release {manifest['tag']}")
    updates = site / "updates"
    updates.mkdir(parents=True)
    apk = updates / name
    # A temporary CDN failure must not replace the previous published site.
    apk_url = f"https://github.com/{REPOSITORY}/releases/download/{manifest['tag']}/{name}"
    subprocess.run([
        "curl", "--fail", "--silent", "--show-error", "--location", "--retry", "2",
        "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "10", "--max-time", "45",
        "--output", str(apk), apk_url,
    ], check=True)
    with apk.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if apk.stat().st_size != manifest["size"] or digest != manifest["sha256"]:
        raise ValueError("Downloaded APK does not match the Release asset")
    (updates / "latest.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
    (site / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>DeepSeek API 下载</title><h1>DeepSeek API</h1>'
        f'<p><a href="updates/{name}" download>下载 {name}</a></p>'
        f'<p><a href="https://github.com/{REPOSITORY}/releases/latest">GitHub Releases</a></p></html>\n',
        encoding="utf-8",
    )
    print(f"Prepared {name} ({manifest['size']} bytes, SHA-256 {manifest['sha256']})")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
