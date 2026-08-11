# career-ops container
# Base: Playwright image with Chromium preinstalled (matches playwright@1.61.0 in package.json).
# Host kernels that block Playwright's chromium installer (e.g. Ubuntu 26.04) work fine here
# because the browser ships in the image and runs under the image's userland.

FROM mcr.microsoft.com/playwright:v1.61.0-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=development \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATH=/usr/local/go/bin:$PATH

# Optional: Go toolchain for the dashboard TUI (./dashboard).
# Small footprint, keeps full feature parity with the README setup.
ARG GO_VERSION=1.23.4
RUN set -eux; \
    apt-get update; \
    # texlive-fonts-extra is required by the AltaCV CV path: altacv.cls hard-requires
    # fontawesome5 (\RequirePackage[fixed]{fontawesome5}), cv-altacv.tex uses lato, and
    # academicons is pulled in for the icon set. None ship in *-recommended or
    # latex-extra, so without this the AltaCV compile dies with
    # "! LaTeX Error: File `fontawesome5.sty' not found." and produces no PDF at all.
    # It is a large package (~1.2 GB installed) — that cost buys the LaTeX CV pipeline.
    apt-get install -y --no-install-recommends ca-certificates curl git tini latexmk texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra texlive-xetex; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64)  go_arch=amd64 ;; \
      arm64)  go_arch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" -o /tmp/go.tgz; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm /tmp/go.tgz; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prime npm deps in a layer so rebuilds stay fast.
# Pin playwright to the version that matches the base image's bundled chromium.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund \
 && npm install --no-audit --no-fund --save-exact playwright@1.61.0

# Claude Code CLI — the batch workers (`claude -p`) run inside this container,
# alongside the ingest server and Playwright. Installed globally (outside
# /app/node_modules) so the named node_modules volume can't shadow it.
RUN npm install -g @anthropic-ai/claude-code

# Non-root runtime home owned by uid 1000 (the host user). The container runs
# unprivileged as 1000:1000 (see docker-compose.yml); HOME points here and the
# `careerops-claude-home` named volume mounts here, so Claude Code's session
# (~/.claude) is container-owned — the host's credentials are never mounted in.
# Creating it owned by 1000 also seeds the named volume with the right ownership
# on first mount, so the unprivileged user can write its login.
RUN mkdir -p /home/cops && chown -R 1000:1000 /home/cops

# The rest of the project is bind-mounted at runtime via docker compose,
# so we don't COPY sources here — keeps the image generic and lets local
# edits show up instantly inside the container.

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]
