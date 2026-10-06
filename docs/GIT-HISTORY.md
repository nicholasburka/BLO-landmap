# Rewriting history in this repo

Written after a botched purge on 2026-10-03. Read this before any `filter-repo`,
`filter-branch` or force-push.

## Why a rewrite ever happens here

GitHub push protection scans the **whole ref**, not just the tip. A secret committed and
later redacted still blocks the push, because the blob is in history. That is what happened
with `server/eval/inspect/pages/socrata-cdc-wwi.html`: a saved copy of a third-party page
carried that site's own public Mapbox token, introduced 2026-09-06 and redacted 2026-09-22.
HEAD was clean; the push was still refused.

**Do not use GitHub's "allow this secret" unblock link.** It permanently whitelists
publishing a credential — here, somebody else's.

## The four rules

1. **Never rewrite with a dirty working tree.** `--force` on a dirty tree can discard
   uncommitted changes to tracked files. Do the rewrite in a bare mirror instead:

   ```bash
   git clone --mirror . /tmp/blo-rewrite.git
   cd /tmp/blo-rewrite.git
   git filter-repo --replace-text /path/to/replacements.txt \
       --refs main..phase6-knowledge-base --partial --force
   git push git@github.com:nicholasburka/BLO-landmap.git phase6-knowledge-base
   ```

   A bare repo has no working tree, so concurrent work cannot be lost.

2. **Scope `--refs` to a RANGE above the published tip** — `main..<branch>`, never a bare
   branch name. A bare branch rewrites *every* commit's SHA, including the ones `main`
   already published, because `--replace-text` scans all history for the pattern. That
   leaves the branch **disjoint from `main`** (`git merge-base` returns nothing), and the
   only ways out are force-pushing published history or a duplicate merge. Confirm first
   that the carrier commit is above the tip:

   ```bash
   git merge-base --is-ancestor origin/main <carrier-sha>   # must succeed
   ```

3. **Back up every ref named in `--refs`,** not just the one checked out:

   ```bash
   git branch backup-pre-rewrite-$(date +%Y%m%d) <branch>
   ```

4. **Verify ancestry before pushing:**

   ```bash
   git merge-base --is-ancestor origin/main <branch> && echo FAST-FORWARD OK
   ```

## Writing the replacement rule

Use a regex so the secret never has to be read or stored:

```
regex:pk\.eyJ1[A-Za-z0-9._-]{20,}==>pk.REDACTED-THIRD-PARTY-TOKEN
```

Keep the rule narrow. A broad pattern will match blobs in early history you did not intend
to touch — which is exactly what broke the ancestry in rule 2.

## Afterwards

The tree should be byte-identical; only SHAs move. Prove it:

```bash
git diff --stat backup-pre-rewrite-YYYYMMDD <branch>   # expect empty
git rev-list --count backup-pre-rewrite-YYYYMMDD <branch>  # expect equal counts
```
