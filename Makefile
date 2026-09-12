# ====================================================================
# DeepCode 开发容器入口 (Makefile)
# 主要目标：
#   make shell          -> 进入唯一开发容器（镜像与容器状态自动收敛）
#   make build          -> 等同 bash ./build.sh，尝试全平台打包，缺少支持环境时跳过
#   make build-deepcode-gui -> 在 Docker 内构建 DeepCode-GUI dist
#   make build-deepcode-gui-tauri -> 在 Docker 内构建 Windows DeepCode-GUI.exe
#   make dev-deepcode-gui   -> 在 Docker 内启动当前配置端口的 DeepCode-GUI 调试服务
#   make reset-dev      -> 仅重建开发容器，保留依赖与编译缓存
#   make clean          -> 清理开发容器、镜像与开发缓存 volumes
#   make macos-package-service -> 在 macOS 宿主机启动 Docker 可请求的打包服务
#   make package-macos  -> 生成完整 macOS 发布包：DeepCode.app + DeepCode-GUI.app + CLI/TUI
#   make package-macos-clean -> 清理打包缓存后重新生成 Darwin GUI/TUI 本机包
#   make package-macos-deepcode-gui -> 刷新 DeepCode-GUI.app，并同步刷新共享同一运行时的现有 App
#
# 适用环境：Linux / macOS / WSL（必须能直连 Docker daemon）
# 不支持：Windows 原生 PowerShell 直接调用（请先 wsl 进入 Linux 子系统）
# ====================================================================

# ---- 基础常量（与项目结构强绑定）----
IMAGE_NAME       ?= deepcode-dev
IMAGE_TAG        ?= latest
IMAGE            := $(IMAGE_NAME):$(IMAGE_TAG)
DOCKERFILE       ?= Dockerfile.dev
WORKDIR_IN_CTNR  ?= /workspace
DEEPCODE_PROJECT_ROOT := $(realpath $(CURDIR))
DEEPCODE_BUILD_HOST_OS := $(shell uname -s)
DEEPCODE_BUILD_STAGES ?= all
CONTAINER_NAME ?= deepcode-dev
CONTAINER_HOSTNAME ?= deepcode-dev
DEEPCODE_HOST_PORT ?= 31246
DEEPCODE_CONTAINER_PORT ?= 31246
DEEPCODE_RUST_TOOLCHAIN ?= $(shell awk -F '"' '/^[[:space:]]*channel[[:space:]]*=/ { print $$2; exit }' rust-toolchain.toml)
DEEPCODE_RUST_VERSION ?= $(patsubst %.0,%,$(DEEPCODE_RUST_TOOLCHAIN))
DEEPCODE_APT_MIRROR ?= https://mirrors.tuna.tsinghua.edu.cn/debian
DEEPCODE_APT_SECURITY_MIRROR ?= https://mirrors.tuna.tsinghua.edu.cn/debian-security
DEEPCODE_NODE_VERSION ?= 22.22.3
DEEPCODE_NODE_DIST_BASE ?= https://npmmirror.com/mirrors/node
DEEPCODE_NPM_REGISTRY ?= https://registry.npmmirror.com
DEEPCODE_RUSTUP_DIST_SERVER ?= https://mirrors.ustc.edu.cn/rust-static
DEEPCODE_RUSTUP_UPDATE_ROOT ?= https://mirrors.ustc.edu.cn/rust-static/rustup
UNAME_R := $(shell uname -r 2>/dev/null)
IS_WSL := $(findstring Microsoft,$(UNAME_R))$(findstring microsoft,$(UNAME_R))
DEEPCODE_DOCKER_NET_ENV_PASSTHROUGH ?= auto
DEEPCODE_CONTAINER_CARGO_TARGET_DIR ?= $(WORKDIR_IN_CTNR)/target
DEEPCODE_CONTAINER_TMPDIR ?= /tmp/deepcode-build
DEEPCODE_CONTAINER_SCCACHE_DIR ?= $(WORKDIR_IN_CTNR)/target/.sccache
BUILD_ARGS := \
	--build-arg DEEPCODE_RUST_VERSION=$(DEEPCODE_RUST_VERSION) \
	--build-arg DEEPCODE_APT_MIRROR=$(DEEPCODE_APT_MIRROR) \
	--build-arg DEEPCODE_APT_SECURITY_MIRROR=$(DEEPCODE_APT_SECURITY_MIRROR) \
	--build-arg DEEPCODE_NODE_VERSION=$(DEEPCODE_NODE_VERSION) \
	--build-arg DEEPCODE_NODE_DIST_BASE=$(DEEPCODE_NODE_DIST_BASE) \
	--build-arg DEEPCODE_NPM_REGISTRY=$(DEEPCODE_NPM_REGISTRY) \
	--build-arg DEEPCODE_RUSTUP_DIST_SERVER=$(DEEPCODE_RUSTUP_DIST_SERVER) \
	--build-arg DEEPCODE_RUSTUP_UPDATE_ROOT=$(DEEPCODE_RUSTUP_UPDATE_ROOT)

# ---- 持久化卷（只有 make clean 才会清空，避免每次 shell 重装依赖）----
VOL_PNPM_STORE        ?= deepcode-pnpm-store
VOL_CARGO_REGISTRY    ?= deepcode-cargo-registry
VOL_CARGO_TARGET      ?= deepcode-cargo-target
VOL_NODE_MODULES      ?= deepcode-node-modules
VOLUMES_ALL := $(VOL_PNPM_STORE) $(VOL_CARGO_REGISTRY) $(VOL_CARGO_TARGET) $(VOL_NODE_MODULES)

# ---- WSL / Docker 网络变量透传 ----
# 默认只在 WSL 自动启用，避免污染 macOS / Linux Docker 开发环境。
# 仅传变量名，不在日志中展开值；docker run/exec 会从当前 shell 读取同名变量。
NETWORK_ENV_ARGS_BASE := \
	-e HTTP_PROXY \
	-e HTTPS_PROXY \
	-e ALL_PROXY \
	-e NO_PROXY \
	-e http_proxy \
	-e https_proxy \
	-e all_proxy \
	-e no_proxy \
	-e CARGO_HTTP_PROXY \
	-e CARGO_HTTP_TIMEOUT \
	-e CARGO_HTTP_CAINFO \
	-e CARGO_HTTP_PROXY_CAINFO \
	-e DEEPCODE_CARGO_SOURCE \
	-e DEEPCODE_CARGO_FALLBACK_REGISTRY_URL \
	-e DEEPCODE_CARGO_OFFICIAL_CWD

ifeq ($(DEEPCODE_DOCKER_NET_ENV_PASSTHROUGH),1)
NETWORK_ENV_ARGS := $(NETWORK_ENV_ARGS_BASE)
else ifeq ($(DEEPCODE_DOCKER_NET_ENV_PASSTHROUGH),0)
NETWORK_ENV_ARGS :=
else ifneq ($(IS_WSL),)
NETWORK_ENV_ARGS := $(NETWORK_ENV_ARGS_BASE)
else
NETWORK_ENV_ARGS :=
endif

# ---- 容器运行参数 ----
# - $(CURDIR) 在 WSL 内自动为 /mnt/e/Dev-Agent/deepagent，挂载到容器 /workspace
# - named volumes 覆盖 node_modules / target，避免 Windows ↔ WSL ↔ 容器 IO 雪崩
RUN_ARGS := \
	--name $(CONTAINER_NAME) \
	--hostname $(CONTAINER_HOSTNAME) \
	--init \
	--label com.deepcode.project.root=$(DEEPCODE_PROJECT_ROOT) \
	-w $(WORKDIR_IN_CTNR) \
	-p 127.0.0.1:$(DEEPCODE_HOST_PORT):$(DEEPCODE_CONTAINER_PORT) \
	-v $(DEEPCODE_PROJECT_ROOT):$(WORKDIR_IN_CTNR) \
	-v $(VOL_PNPM_STORE):/root/.local/share/pnpm/store \
	-v $(VOL_CARGO_REGISTRY):/usr/local/cargo/registry \
	-v $(VOL_CARGO_TARGET):/workspace/target \
	-v $(VOL_NODE_MODULES):/workspace/node_modules \
	-e CARGO_HOME=/usr/local/cargo \
	-e RUSTUP_HOME=/usr/local/rustup \
	-e PNPM_HOME=/root/.local/share/pnpm \
	-e CARGO_TARGET_DIR=$(DEEPCODE_CONTAINER_CARGO_TARGET_DIR) \
	-e DEEPCODE_TMPDIR=$(DEEPCODE_CONTAINER_TMPDIR) \
	-e SCCACHE_DIR=$(DEEPCODE_CONTAINER_SCCACHE_DIR) \
	-e DEEPCODE_BUILD_HOST_OS=$(DEEPCODE_BUILD_HOST_OS) \
	-e PATH=/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	$(NETWORK_ENV_ARGS)

.PHONY: help docker-info branch-audit branch-hooks shell build build-deepcode-gui build-deepcode-gui-tauri dev-deepcode-gui reset-dev clean macos-package-service macos-package-service-status macos-package-service-stop package-macos package-macos-clean package-macos-deepcode-gui _validate_config _print_image _ensure_image _ensure_container _build_in_container

# ---- help：默认目标，列出可用入口 ----
help:
	@echo "DeepCode 开发容器入口"
	@echo ""
	@echo "  make shell          进入唯一开发容器（自动更新镜像并收敛容器）"
	@echo "  make build          尝试 Linux、Windows、macOS 全平台打包；缺少支持环境时跳过"
	@echo "  make build-deepcode-gui  在 Docker 内构建 DeepCode-GUI dist"
	@echo "  make build-deepcode-gui-tauri  在 Docker 内构建 Windows DeepCode-GUI.exe"
	@echo "  make docker-info    显示当前项目的容器、挂载、端口、工具链和 volume 配置"
	@echo "  make branch-audit   只读检查 worktree 与短期分支生命周期"
	@echo "  make branch-hooks   安装 main/dev-main 的共享 Git 防护 hook"
	@echo "  make dev-deepcode-gui    在 Docker 内启动 DeepCode-GUI 调试服务：127.0.0.1:$(DEEPCODE_HOST_PORT)"
	@echo "  make reset-dev      仅移除唯一开发容器；下次命令自动重建并保留缓存"
	@echo "  make clean          清理唯一开发容器、镜像和全部开发缓存 volumes"
	@echo "  make macos-package-service  在 macOS 宿主机启动 Docker 打包请求服务"
	@echo "  make package-macos  生成完整 macOS 发布包：DeepCode.app + DeepCode-GUI.app + CLI/TUI"
	@echo "  make package-macos-clean  清理打包缓存后重新生成 macOS 本机包（保留 config/sessions/archives/kernel）"
	@echo "  make package-macos-deepcode-gui  刷新 DeepCode-GUI.app，并同步刷新共享同一运行时的现有 App"
	@echo ""
	@echo "进入容器后可手动执行："
	@echo "  bash ./build.sh   尝试全平台打包到 bin/；缺少支持环境时明确跳过"
	@echo "  bash ./test.sh --help  查看测试 profile"
	@echo "  bash ./test.sh    运行默认 required 验证（宿主机不会降级为静态成功）"
	@echo "  bash ./test.sh --profile static  显式运行宿主机安全静态检查"

docker-info:
	@echo "projectRoot=$(DEEPCODE_PROJECT_ROOT)"
	@echo "macosOutputRoot=$(DEEPCODE_PROJECT_ROOT)/bin/macos-arm64"
	@echo "rustToolchain=$(DEEPCODE_RUST_TOOLCHAIN)"
	@echo "rustVersion=$(DEEPCODE_RUST_VERSION)"
	@echo "image=$(IMAGE)"
	@echo "container=$(CONTAINER_NAME)"
	@echo "hostname=$(CONTAINER_HOSTNAME)"
	@echo "hostPort=$(DEEPCODE_HOST_PORT)"
	@echo "containerPort=$(DEEPCODE_CONTAINER_PORT)"
	@echo "cargoTargetVolume=$(VOL_CARGO_TARGET)"
	@echo "nodeModulesVolume=$(VOL_NODE_MODULES)"

branch-audit:
	@bash ./scripts/branch-flow.sh audit

branch-hooks:
	@bash ./scripts/branch-flow.sh install-hooks

_validate_config:
	@if [ ! -d "$(DEEPCODE_PROJECT_ROOT)" ]; then \
		echo "[make][error] 项目根目录不可用: $(DEEPCODE_PROJECT_ROOT)" >&2; \
		exit 1; \
	fi
	@if [ -z "$(DEEPCODE_RUST_TOOLCHAIN)" ] || [ -z "$(DEEPCODE_RUST_VERSION)" ]; then \
		echo "[make][error] rust-toolchain.toml 缺少有效 channel" >&2; \
		exit 1; \
	fi
	@case "$(DEEPCODE_HOST_PORT)" in ''|*[!0-9]*) echo "[make][error] DEEPCODE_HOST_PORT 必须是 1-65535 的整数" >&2; exit 1;; esac
	@if [ "$(DEEPCODE_HOST_PORT)" -lt 1 ] || [ "$(DEEPCODE_HOST_PORT)" -gt 65535 ]; then \
		echo "[make][error] DEEPCODE_HOST_PORT 必须是 1-65535 的整数" >&2; \
		exit 1; \
	fi

macos-package-service:
	@bash ./build.sh --stage macos-package-service

macos-package-service-status:
	@bash ./scripts/macos-package-service.sh status

macos-package-service-stop:
	@bash ./scripts/macos-package-service.sh stop

package-macos:
	@bash ./build.sh --stage package-macos

package-macos-clean:
	@bash ./build.sh --stage package-macos --clean-cache

package-macos-deepcode-gui:
	@bash ./build.sh --stage package-macos-deepcode-gui

# ---- _ensure_image：每次求值 Dockerfile，未变化时直接命中 Docker 缓存 ----
_print_image:
	@printf '%s\n' '$(IMAGE)'

_ensure_image: _validate_config
	@echo "[make] 更新开发镜像 $(IMAGE)（未变化层使用 Docker 缓存）..."
	@docker build --provenance=false $(BUILD_ARGS) -f $(DOCKERFILE) -t $(IMAGE) .

# ---- _ensure_container：容器懒创建 / 刷新启动 ----
# 状态机：
#   not exists  -> docker run -d
#   stale       -> 精确移除该容器后重建（源码挂载、镜像或端口变化）
#   running     -> reuse
#   exited      -> docker start
_ensure_container: _ensure_image
	@if docker container inspect $(CONTAINER_NAME) >/dev/null 2>&1; then \
		mounted_root=$$(docker container inspect -f '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' $(CONTAINER_NAME)); \
		container_image=$$(docker container inspect -f '{{.Image}}' $(CONTAINER_NAME)); \
		current_image=$$(docker image inspect -f '{{.Id}}' $(IMAGE)); \
		actual_host_port=$$(docker container port $(CONTAINER_NAME) $(DEEPCODE_CONTAINER_PORT)/tcp 2>/dev/null | awk -F: 'NR == 1 { print $$NF }'); \
		reason=""; \
		if [ "$$mounted_root" != "$(DEEPCODE_PROJECT_ROOT)" ]; then reason="源码挂载已变化"; \
		elif [ "$$container_image" != "$$current_image" ]; then reason="开发镜像已更新"; \
		elif [ "$$actual_host_port" != "$(DEEPCODE_HOST_PORT)" ]; then reason="端口配置已变化"; \
		fi; \
		if [ -n "$$reason" ]; then \
			echo "[make] $$reason，重建唯一容器 $(CONTAINER_NAME) 并保留 named volumes..."; \
			docker rm -f $(CONTAINER_NAME) >/dev/null; \
		fi; \
	fi; \
	if ! docker container inspect $(CONTAINER_NAME) >/dev/null 2>&1; then \
		echo "[make] 创建并启动唯一容器 $(CONTAINER_NAME)..."; \
		docker run -d $(RUN_ARGS) $(IMAGE) /usr/local/bin/entrypoint.sh >/dev/null; \
	else \
		status=$$(docker container inspect -f '{{.State.Status}}' $(CONTAINER_NAME) 2>/dev/null | tr -d '[:space:]'); \
		case "$$status" in \
			running) \
				echo "[make] 容器 $(CONTAINER_NAME) 正在运行，直接复用"; \
				;; \
			exited|created) \
				echo "[make] 容器 $(CONTAINER_NAME) 处于 $$status，start 启动..."; \
				docker start $(CONTAINER_NAME) >/dev/null ; \
				;; \
			paused) \
				echo "[make] 容器 $(CONTAINER_NAME) 已暂停，unpause 恢复..."; \
				docker unpause $(CONTAINER_NAME) >/dev/null ; \
				;; \
			dead) \
				echo "[make] 容器 $(CONTAINER_NAME) 已失效，精确重建并保留 named volumes..."; \
				docker rm -f $(CONTAINER_NAME) >/dev/null ; \
				docker run -d $(RUN_ARGS) $(IMAGE) /usr/local/bin/entrypoint.sh >/dev/null ; \
				;; \
			*) \
				echo "[make][error] 不支持的容器状态 [$$status]；请执行 make reset-dev" >&2; \
				exit 1; \
				;; \
		esac; \
	fi

# ---- shell：唯一交互入口 ----
shell: _ensure_container
	@if [ "$(DEEPCODE_BUILD_HOST_OS)" = "Darwin" ]; then bash ./scripts/macos-package-service.sh start; fi
	@echo "[make] exec 进入容器 $(CONTAINER_NAME) ..."
	@docker exec -it $(NETWORK_ENV_ARGS) -e DEEPCODE_BUILD_HOST_OS=$(DEEPCODE_BUILD_HOST_OS) $(CONTAINER_NAME) bash

build:
	@bash ./build.sh

_build_in_container: _ensure_container
	@docker exec $(NETWORK_ENV_ARGS) -e DEEPCODE_BUILD_HOST_OS=$(DEEPCODE_BUILD_HOST_OS) $(CONTAINER_NAME) bash ./build.sh --stage "$(DEEPCODE_BUILD_STAGES)"

build-deepcode-gui: _ensure_container
	@echo "[make] Docker 内构建 DeepCode-GUI dist ..."
	@docker exec $(NETWORK_ENV_ARGS) $(CONTAINER_NAME) bash -c 'bash ./build.sh --stage deepcode-gui'

build-deepcode-gui-tauri: _ensure_container
	@echo "[make] Docker 内构建 Windows DeepCode-GUI.exe ..."
	@docker exec $(NETWORK_ENV_ARGS) $(CONTAINER_NAME) bash -c 'bash ./build.sh --stage deepcode-gui-tauri'

dev-deepcode-gui: _ensure_container
	@echo "[make] Docker 内启动 DeepCode-GUI 调试服务：http://127.0.0.1:$(DEEPCODE_HOST_PORT)/"
	@docker exec -it $(NETWORK_ENV_ARGS) $(CONTAINER_NAME) bash -c 'bash ./build.sh --stage deepcode-gui && DEEPCODE_HOST=0.0.0.0 DEEPCODE_PORT=$(DEEPCODE_CONTAINER_PORT) DEEPCODE_CLIENT_DIST=userspace/gui/dist-deepcode-gui cargo run -p deepcode-host-web'

# ---- reset-dev / clean：只操作固定命名的单仓开发资源 ----
reset-dev:
	@echo "[make] 移除唯一开发容器 $(CONTAINER_NAME)，保留依赖与编译缓存 ..."
	-@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	@echo "[make] 重置完成；下次 make shell/build 会按当前源码与镜像重建容器。"

clean:
	@echo "[make] 强制移除容器 $(CONTAINER_NAME) ..."
	-@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	@echo "[make] 强制移除镜像 $(IMAGE) ..."
	-@docker rmi -f $(IMAGE) >/dev/null 2>&1 || true
	@echo "[make] 移除 named volumes ..."
	-@for v in $(VOLUMES_ALL); do \
		docker volume rm $$v >/dev/null 2>&1 && echo "  - removed volume $$v" || echo "  - skip $$v (不存在)"; \
	done
	@echo "[make] 清理完成。下次 'make shell' 将重建当前配置需要的容器环境。"
	@echo "[make] 注意：宿主机 ./bin、./node_modules（如存在于宿主端）未被本目标修改。"
