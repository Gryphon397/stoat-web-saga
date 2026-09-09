# Submodule fork patches

Both submodules here point at upstream repos we do **not** own:

| Submodule | Origin | Pinned base |
|-----------|--------|-------------|
| `packages/stoat.js` | `stoatchat/javascript-client-sdk` | `e1a9c8a8` |
| `packages/solid-livekit-components` | `revoltchat/solid-livekit-components` | `e2831713` |

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

## Regenerating after further submodule edits

```bash
git -C packages/stoat.js format-patch -1 --stdout stoat-fork \
  > patches/submodules/stoat.js-fork.patch
```

## Caveat

`git am` will fail if the pinned base moves. `packages/stoat.js` is 42
commits behind upstream and a bump is tracked in `StoatData-42o`; when that
lands, these patches must be rebased onto the new base rather than reapplied
blind. The `stoat.js` patch touches `EventClient.ts` and `events/v1.ts`,
which upstream has been actively changing.

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
