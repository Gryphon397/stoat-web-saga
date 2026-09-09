# Submodule fork patches

Both submodules here point at upstream repos we do **not** own:

| Submodule | Origin | Pinned base | Local commits |
|-----------|--------|-------------|---------------|
| `packages/stoat.js` | `stoatchat/javascript-client-sdk` | `44d45ade` | 1 |
| `packages/solid-livekit-components` | `revoltchat/solid-livekit-components` | `a4f98b78` | 7 |

We carry local fixes in both. Because we can't push to either origin, the
submodule commits exist only on this machine — and the parent repo's
submodule pointers are deliberately left on the upstream bases, *not* moved
to our local commits.

That's on purpose. Moving a pointer to a commit that doesn't exist on the
remote makes `git submodule update --init` fail for anyone cloning, which is
the exact breakage documented in the root `CLAUDE.md`.

So these `.patch` files are the durable copy. They're what actually gets
pushed to GitHub.

## Reapplying after a fresh clone or a `submodule update`

```bash
cd packages/stoat.js
git checkout -b stoat-fork
git am ../../patches/submodules/stoat.js-fork.patch

cd ../solid-livekit-components
git checkout -b stoat-fork
git am ../../patches/submodules/solid-livekit-components-fork.patch
```

Then regenerate the build artifacts, or nothing downstream will typecheck —
`solid-livekit-components` has no committed `dist/`, so without this step
every import of it resolves to nothing:

```bash
pnpm build:deps
```

## Regenerating after further submodule edits

Always regenerate from the **pinned base** in the table above. Do not use
`-1`: it captures only the newest commit and silently drops the rest of the
fork. That is exactly how `solid-livekit-components` came to have 6 of its 7
commits missing from its patch file (found and fixed 2026-09-09 under
`StoatData-u7d`).

```bash
git -C packages/stoat.js format-patch 44d45ade..stoat-fork --stdout > patches/submodules/stoat.js-fork.patch

git -C packages/solid-livekit-components format-patch a4f98b78..stoat-fork --stdout > patches/submodules/solid-livekit-components-fork.patch
```

Check the commit count landed as expected:

```bash
grep -c '^From ' patches/submodules/solid-livekit-components-fork.patch
```

## Verifying a patch actually applies

A regenerated patch is worth nothing until it's been replayed onto a clean
checkout. Do it against a throwaway clone so the real working tree — which
the Docker build copies — is never disturbed:

```bash
git clone --shared --no-checkout packages/solid-livekit-components /tmp/slk-test
cd /tmp/slk-test
git checkout -b amtest a4f98b78
git am /d/StoatData/stoat-web-dev/patches/submodules/solid-livekit-components-fork.patch
```

## The pointer must be a commit that exists on the origin

Checked 2026-09-09: the `solid-livekit-components` pointer recorded
`e2831713`, which is one of *our* commits and exists on no remote. That is
the precise failure this file warns about — `git submodule update --init`
could never have resolved it from a fresh clone. The pointer is now
`a4f98b78`, the real merge-base with `origin/main`.

Before recording any pointer, confirm the target is reachable from the
origin:

```bash
git -C packages/solid-livekit-components branch -r --contains <sha>
```

An empty result means the commit is local-only — do not record it. To set a
pointer without moving the working tree off `stoat-fork`:

```bash
git update-index --cacheinfo 160000,<sha>,packages/solid-livekit-components
```

## Caveat

`git am` will fail if the pinned base moves. When you bump a base, the patch
must be **rebased** onto it, not reapplied blind.

`packages/stoat.js` was bumped from `e1a9c8a8` to `44d45ade` on 2026-09-09
under `StoatData-42o` (47 upstream commits). The patch touches
`EventClient.ts`, `events/v1.ts`, `classes/Server.ts` and `classes/User.ts`,
all of which upstream changes regularly — `Server.syncMembers` in particular
was rewritten upstream (`ee0a9803`) and the fork hunk had to be reworked
around the new `hydrateIfNotHas`/`addHydratedUser` split.

`packages/solid-livekit-components` is still on its original base.

## Why `git status` shows both submodules as modified

After applying these patches the submodules sit on their `stoat-fork`
branches, while the parent index still records the upstream bases. Git
reports that as:

```
 M packages/solid-livekit-components
 M packages/stoat.js
```

**This is the intended steady state — do not "fix" it by staging them.**

The submodules must stay on `stoat-fork` because the Docker build copies the
working tree, so the build needs the patched sources. But the *pointers* must
stay on the upstream bases so clones keep working. Those two facts can't both
be satisfied without a permanently dirty-looking status.

Practical consequence: **never `git add -A` at the repo root** without
checking what it staged. It will pick up the pointer move and break
`git submodule update --init` for prod. Stage paths explicitly instead.

If you genuinely mean to bump a submodule (e.g. the `stoat.js` bump in
`StoatData-42o`), that's a deliberate `git add packages/stoat.js` alongside a
rebase of the patch above — not an incidental `-A`.
