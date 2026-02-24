<div align="center">
<h1>
  Stoat Frontend - Fork
  
  [![Stars](https://img.shields.io/github/stars/Trifall/stoat-for-web?style=flat-square&logoColor=white)](https://github.com/Trifall/stoat-for-web/stargazers)
  [![Forks](https://img.shields.io/github/forks/Trifall/stoat-for-web?style=flat-square&logoColor=white)](https://github.com/Trifall/stoat-for-web/network/members)
  [![Pull Requests](https://img.shields.io/github/issues-pr/Trifall/stoat-for-web?style=flat-square&logoColor=white)](https://github.com/Trifall/stoat-for-web/pulls)
  [![Issues](https://img.shields.io/github/issues/Trifall/stoat-for-web?style=flat-square&logoColor=white)](https://github.com/Trifall/stoat-for-web/issues)
  [![Contributors](https://img.shields.io/github/contributors/Trifall/stoat-for-web?style=flat-square&logoColor=white)](https://github.com/Trifall/stoat-for-web/graphs/contributors)
  [![License](https://img.shields.io/github/license/Trifall/stoat-for-web?style=flat-square&logoColor=white)](https://github.com/Trifall/stoat-for-web/blob/main/LICENSE)
</h1>

**This is a fork of the original Stoat web client.**

View the paired desktop client fork at **[https://github.com/Trifall/stoat-for-desktop](https://github.com/Trifall/stoat-for-desktop)**

The official web client powering https://stoat.chat/app, built with <a href="https://www.solidjs.com/">Solid.js</a> 💖. <br/>
Track the project roadmap on <a href="https://op.stoatinternal.com/projects/revolt-for-web/roadmap">OpenProject</a>.
</div>
<br/>

## Development Guide

Before contributing, make yourself familiar with [our contribution guidelines](https://developers.stoat.chat/developing/contrib/), the [code style guidelines](./GUIDELINES.md), and the [technical documentation for this project](https://stoatchat.github.io/for-web/).

Before getting started, you'll want to install:

- [Git](https://git-scm.com/install/)
- [mise-en-place](https://mise.jdx.dev/getting-started.html)

Then proceed to setup:

```bash
# clone the repository
git clone --recursive https://github.com/Trifall/stoat-for-web client
cd client

# update submodules if you pull new changes
# git submodule init && git submodule update

# install all packages
mise install:frozen

# build deps:
mise build:deps

# or build a specific dep (e.g. stoat.js updates):
# pnpm --filter stoat.js run build

# customise the .env
cp packages/client/.env.example packages/client/.env

# run dev server
mise dev

# run all CI checks locally
mise check
```

Finally, navigate to http://local.revolt.chat:5173.

### Pulling in Stoat's brand assets

If you want to pull in Stoat brand assets after pulling, run the following:

```bash
# update the assets
git -c submodule."packages/client/assets".update=checkout submodule update --init packages/client/assets
```

You can switch back to the fallback assets by running deinit and continuing as normal:

```bash
# deinit submodule which clears directory
git submodule deinit packages/client/assets
```

## Deployment Guide

### Build the app

```bash
# install packages
mise install:frozen

# build dependencies
mise build:deps

# build for web
mise build

# ... when building for Stoat production
mise build:prod
```

You can now deploy the directory `packages/client/dist`.

### Routing Information

The app currently needs the following routes:

- `/login`
- `/pwa`
- `/dev`
- `/discover`
- `/settings`
- `/invite`
- `/bot`
- `/friends`
- `/server`
- `/channel`

This corresponds to [Content.tsx#L33](packages/client/src/index.tsx).