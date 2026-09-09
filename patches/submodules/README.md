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
