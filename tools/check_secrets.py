"""
Pre-commit secret check: blocks a commit that stages credentials.

Installed as .git/hooks/pre-commit by setup_security.bat. Run by hand with:
    python tools/check_secrets.py            (checks staged files)
Bypass for a false positive (think twice): git commit --no-verify
"""
import re
import subprocess
import sys

# Files that must never be committed, whatever they contain.
BLOCKED_NAMES = re.compile(
    r"(^|/)(\.env(\..+)?|sleep_sync\.env|wearable_sleep\.db.*|mqtt_credentials\.env|telegram\.env|voice\.env|ikea\.env|secrets\.h|.*\.pem|.*\.key|id_rsa.*|.*\.pkl)$",
    re.IGNORECASE,
)
ALLOWED_NAMES = re.compile(r"(^|/)(\.env\.example|secrets\.example\.h)$", re.IGNORECASE)

# Content patterns that look like real credentials.
SECRET_PATTERNS = [
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("GitHub token", re.compile(r"\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Anthropic/OpenAI key", re.compile(r"\bsk-(ant-)?[A-Za-z0-9_-]{20,}")),
    ("Slack token", re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}")),
    ("Telegram bot token", re.compile(r"\b\d{6,12}:AA[A-Za-z0-9_-]{30,}")),
    ("hard-coded password",
     re.compile(r"""(?i)\b(password|passwd|pwd|pass)\b["']?\s*[:=]\s*["'][^"'\s]{4,}["']""")),
    ("hard-coded password (#define)",
     re.compile(r"""(?i)#define\s+\w*(PASS|PASSWORD)\w*\s+"[^"]{4,}\"""")),
]
# Placeholders that are fine to commit.
PLACEHOLDER = re.compile(r"(?i)change-me|your-|example|placeholder|xxxx|\*\*\*")


def staged_files() -> list[str]:
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        capture_output=True, text=True, check=True,
    ).stdout
    return [line for line in out.splitlines() if line]


def staged_content(path: str) -> str:
    result = subprocess.run(["git", "show", f":{path}"], capture_output=True)
    return result.stdout.decode("utf-8", errors="ignore")


def main() -> int:
    problems = []
    for path in staged_files():
        if BLOCKED_NAMES.search(path) and not ALLOWED_NAMES.search(path):
            problems.append(f"{path}: this file type must not be committed")
            continue
        for lineno, line in enumerate(staged_content(path).splitlines(), 1):
            for label, pattern in SECRET_PATTERNS:
                if pattern.search(line) and not PLACEHOLDER.search(line):
                    problems.append(f"{path}:{lineno}: possible {label}")

    if problems:
        print("COMMIT BLOCKED - possible secrets staged:\n")
        for p in problems:
            print("  " + p)
        print("\nRemove them (git restore --staged <file>) or move them to a git-ignored file.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
