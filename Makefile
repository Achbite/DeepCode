# ====================================================================
# DeepCode 开发容器入口 (Makefile)
# 主要目标：
#   make shell          -> 进入容器（镜像/容器不存在则懒构建；运行中直接复用）
#   make build-deepcode-gui -> 在 Docker 内构建 DeepCode-GUI dist
#   make build-deepcode-gui-tauri -> 在 Docker 内构建 Windows DeepCode-GUI.exe
#   make dev-deepcode-gui   -> 在 Docker 内启动当前配置端口的 DeepCode-GUI 调试服务
#   make clean          -> 清理当前配置拥有的容器与 volumes；默认模式同时清理共享镜像
#   make macos-package-service -> 在 macOS 宿主机启动 Docker 可请求的打包服务
#   make package-macos  -> 生成完整 macOS 发布包：DeepCode.app + DeepCode-GUI.app + CLI/TUI
#   make package-macos-clean -> 清理打包缓存后重新生成 Darwin GUI/TUI 本机包
#   make package-macos-deepcode-gui -> 刷新 DeepCode-GUI.app，并同步刷新共享同一运行时的现有 App
#
# 适用环境：Linux / macOS / WSL（必须能直连 Docker daemon）
# 不支持：Windows 原生 PowerShell 直接调用（请先 wsl 进入 Linux 子系统）
# ====================================================================

# 每个 worktree 可以提供本地未跟踪配置；缺少该文件时保持单容器默认行为。
-include .deepcode-worktree.mk

# ---- 基础常量（与项目结构强绑定）----
IMAGE_NAME       ?= deepcode-dev
IMAGE_TAG        ?= latest
IMAGE            := $(IMAGE_NAME):$(IMAGE_TAG)
DOCKERFILE       ?= Dockerfile.dev
WORKDIR_IN_CTNR  ?= /workspace
DEEPCODE_WORKTREE_ID ?=
DEEPCODE_WORKTREE_ROOT := $(abspath $(CURDIR))
DEEPCODE_GIT_COMMON_DIR := $(abspath $(shell git rev-parse --git-common-dir 2>/dev/null))
DEEPCODE_HOST_PORT ?= 31246
DEEPCODE_CONTAINER_PORT ?= 31246
ifeq ($(strip $(DEEPCODE_WORKTREE_ID)),)
DEEPCODE_WORKTREE_MODE := 0
CONTAINER_NAME ?= deepcode-dev
CONTAINER_HOSTNAME ?= deepcode-dev
WORKTREE_LABEL_ARGS :=
else
DEEPCODE_WORKTREE_MODE := 1
CONTAINER_NAME ?= deepcode-dev-$(DEEPCODE_WORKTREE_ID)
CONTAINER_HOSTNAME ?= deepcode-dev-$(DEEPCODE_WORKTREE_ID)
WORKTREE_LABEL_ARGS := \
	--label com.deepcode.worktree.id=$(DEEPCODE_WORKTREE_ID) \
	--label com.deepcode.worktree.root=$(DEEPCODE_WORKTREE_ROOT)
WORKTREE_GIT_MOUNT_ARG := -v $(DEEPCODE_GIT_COMMON_DIR):$(DEEPCODE_GIT_COMMON_DIR):ro
endif
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
ifeq ($(DEEPCODE_WORKTREE_MODE),1)
VOL_CARGO_TARGET      ?= deepcode-cargo-target-$(DEEPCODE_WORKTREE_ID)
VOL_NODE_MODULES      ?= deepcode-node-modules-$(DEEPCODE_WORKTREE_ID)
VOLUMES_ALL := $(VOL_CARGO_TARGET) $(VOL_NODE_MODULES)
else
VOL_CARGO_TARGET      ?= deepcode-cargo-target
VOL_NODE_MODULES      ?= deepcode-node-modules
VOLUMES_ALL := $(VOL_PNPM_STORE) $(VOL_CARGO_REGISTRY) $(VOL_CARGO_TARGET) $(VOL_NODE_MODULES)
endif

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
	$(WORKTREE_LABEL_ARGS) \
	-w $(WORKDIR_IN_CTNR) \
	-p 127.0.0.1:$(DEEPCODE_HOST_PORT):$(DEEPCODE_CONTAINER_PORT) \
	-v $(CURDIR):$(WORKDIR_IN_CTNR) \
	$(WORKTREE_GIT_MOUNT_ARG) \
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
	-e PATH=/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	$(NETWORK_ENV_ARGS)

.PHONY: help docker-info branch-audit branch-hooks shell build-deepcode-gui build-deepcode-gui-tauri dev-deepcode-gui clean macos-package-service macos-package-service-status macos-package-service-stop package-macos package-macos-clean package-macos-deepcode-gui _validate_worktree_config _ensure_macos_package_service _ensure_image _ensure_container

# ---- help：默认目标，列出可用入口 ----
help:
	@echo "DeepCode 开发容器入口"
	@echo ""
	@echo "  make shell          进入开发容器（容器存在则直接复用后 exec）"
	@echo "  make build-deepcode-gui  在 Docker 内构建 DeepCode-GUI dist"
	@echo "  make build-deepcode-gui-tauri  在 Docker 内构建 Windows DeepCode-GUI.exe"
	@echo "  make docker-info    显示当前 worktree 的容器、挂载、端口和 volume 配置"
	@echo "  make branch-audit   只读检查 worktree 与短期分支生命周期"
	@echo "  make branch-hooks   安装 main/dev-main 的共享 Git 防护 hook"
	@echo "  make dev-deepcode-gui    在 Docker 内启动 DeepCode-GUI 调试服务：127.0.0.1:$(DEEPCODE_HOST_PORT)"
	@echo "  make clean          清理当前配置拥有的容器和 volumes"
	@echo "  make macos-package-service  在 macOS 宿主机启动 Docker 打包请求服务"
	@echo "  make package-macos  生成完整 macOS 发布包：DeepCode.app + DeepCode-GUI.app + CLI/TUI"
	@echo "  make package-macos-clean  清理打包缓存后重新生成 macOS 本机包（保留 config/sessions/archives/kernel）"
	@echo "  make package-macos-deepcode-gui  刷新 DeepCode-GUI.app，并同步刷新共享同一运行时的现有 App"
	@echo ""
	@echo "进入容器后可手动执行："
	@echo "  bash ./build.sh   编译并输出统一分发目录到 bin/"
	@echo "  bash ./test.sh --list  查看测试 profile 与 suite 注册"
	@echo "  bash ./test.sh    运行默认 required 测试门禁（宿主机不会降级为静态成功）"
	@echo "  bash ./test.sh --profile static  显式运行宿主机安全静态检查"

docker-info:
	@echo "worktreeMode=$(DEEPCODE_WORKTREE_MODE)"
	@echo "worktreeId=$(DEEPCODE_WORKTREE_ID)"
	@echo "worktreeRoot=$(DEEPCODE_WORKTREE_ROOT)"
	@echo "gitCommonDir=$(DEEPCODE_GIT_COMMON_DIR)"
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

_validate_worktree_config:
	@if [ "$(DEEPCODE_WORKTREE_MODE)" = "1" ] && ! printf '%s' "$(DEEPCODE_WORKTREE_ID)" | grep -Eq '^[a-z0-9][a-z0-9_.-]*$$'; then \
		echo "[make][error] DEEPCODE_WORKTREE_ID 只能包含小写字母、数字、点、下划线和连字符" >&2; \
		exit 1; \
	fi
	@if [ "$(DEEPCODE_WORKTREE_MODE)" = "1" ] && [ ! -d "$(DEEPCODE_GIT_COMMON_DIR)" ]; then \
		echo "[make][error] worktree Git common dir 不可用: $(DEEPCODE_GIT_COMMON_DIR)" >&2; \
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

_ensure_macos_package_service:
	@if [ "$$(uname -s 2>/dev/null)" = "Darwin" ] && [ "$${DEEPCODE_MACOS_PACKAGE_AUTOSTART:-1}" = "1" ]; then \
		if bash ./scripts/macos-package-service.sh status --quiet >/dev/null 2>&1; then \
			echo "[make] macOS package service 已运行"; \
		else \
			echo "[make] macOS package service 未运行，自动启动..."; \
			bash ./build.sh --stage macos-package-service; \
		fi; \
	fi

# ---- _ensure_image：镜像不存在则构建 ----
_ensure_image: _validate_worktree_config
	@if ! docker image inspect $(IMAGE) >/dev/null 2>&1; then \
		echo "[make] 镜像 $(IMAGE) 不存在，开始构建..."; \
		docker build $(BUILD_ARGS) -f $(DOCKERFILE) -t $(IMAGE) . ; \
	else \
		echo "[make] 镜像 $(IMAGE) 已存在，跳过构建"; \
	fi

# ---- _ensure_container：容器懒创建 / 刷新启动 ----
# 状态机：
#   not exists  -> docker run -d
#   running     -> reuse            (避免构建/打包阶段杀掉当前调试服务)
#   exited      -> docker start
# 实现要点：
#   - 用 `docker container inspect` 显式判存在；不存在时返回非零，进入 run 分支；
#   - 状态字符串经 `tr -d '[:space:]'` 去除任何 \n / \r / 空格，避免 case 误命中 *；
#   - 所有 docker 命令的 stderr 重定向到 /dev/null，仅靠返回值与干净 stdout 决策。
_ensure_container: _ensure_image
	@if ! docker container inspect $(CONTAINER_NAME) >/dev/null 2>&1; then \
		echo "[make] 容器 $(CONTAINER_NAME) 不存在，创建并启动..."; \
		docker run -d $(RUN_ARGS) $(IMAGE) /usr/local/bin/entrypoint.sh >/dev/null ; \
	else \
		if [ "$(DEEPCODE_WORKTREE_MODE)" = "1" ]; then \
			configured_root=$$(docker container inspect -f '{{index .Config.Labels "com.deepcode.worktree.root"}}' $(CONTAINER_NAME) 2>/dev/null); \
			mounted_root=$$(docker container inspect -f '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' $(CONTAINER_NAME) 2>/dev/null); \
			actual_host_port=$$(docker container port $(CONTAINER_NAME) $(DEEPCODE_CONTAINER_PORT)/tcp 2>/dev/null | awk -F: 'NR == 1 { print $$NF }'); \
			if [ "$$configured_root" != "$(DEEPCODE_WORKTREE_ROOT)" ] || [ "$$mounted_root" != "$(DEEPCODE_WORKTREE_ROOT)" ]; then \
				echo "[make][error] 容器 $(CONTAINER_NAME) 绑定了其他 worktree，拒绝复用" >&2; \
				echo "  expected=$(DEEPCODE_WORKTREE_ROOT)" >&2; \
				echo "  label=$$configured_root" >&2; \
				echo "  mount=$$mounted_root" >&2; \
				exit 1; \
			fi; \
			if [ "$$actual_host_port" != "$(DEEPCODE_HOST_PORT)" ]; then \
				echo "[make][error] 容器 $(CONTAINER_NAME) 的 host 端口为 $$actual_host_port，配置要求 $(DEEPCODE_HOST_PORT)" >&2; \
				exit 1; \
			fi; \
		else \
			port_bindings=$$(docker container inspect -f '{{json .NetworkSettings.Ports}}' $(CONTAINER_NAME) 2>/dev/null); \
			if ! printf '%s\n' "$$port_bindings" | grep -q '"$(DEEPCODE_CONTAINER_PORT)/tcp"'; then \
				echo "[make] 容器 $(CONTAINER_NAME) 缺少 $(DEEPCODE_CONTAINER_PORT) 端口映射，重建容器并保留 named volumes..."; \
				docker rm -f $(CONTAINER_NAME) >/dev/null ; \
				docker run -d $(RUN_ARGS) $(IMAGE) /usr/local/bin/entrypoint.sh >/dev/null ; \
				exit 0 ; \
			fi; \
		fi; \
		status=$$(docker container inspect -f '{{.State.Status}}' $(CONTAINER_NAME) 2>/dev/null | tr -d '[:space:]'); \
		case "$$status" in \
			running) \
				echo "[make] 容器 $(CONTAINER_NAME) 正在运行，直接复用"; \
				;; \
			exited|created|paused|dead) \
				echo "[make] 容器 $(CONTAINER_NAME) 处于 $$status，start 启动..."; \
				docker start $(CONTAINER_NAME) >/dev/null ; \
				;; \
			*) \
				echo "[make] 未知容器状态 [$$status]，尝试 restart..."; \
				docker restart $(CONTAINER_NAME) >/dev/null ; \
				;; \
		esac; \
	fi

# ---- shell：唯一交互入口 ----
shell: _ensure_macos_package_service _ensure_container
	@echo "[make] exec 进入容器 $(CONTAINER_NAME) ..."
	@docker exec -it $(NETWORK_ENV_ARGS) $(CONTAINER_NAME) bash

build-deepcode-gui: _ensure_container
	@echo "[make] Docker 内构建 DeepCode-GUI dist ..."
	@docker exec $(NETWORK_ENV_ARGS) $(CONTAINER_NAME) bash -c 'bash ./build.sh --stage deepcode-gui'

build-deepcode-gui-tauri: _ensure_container
	@echo "[make] Docker 内构建 Windows DeepCode-GUI.exe ..."
	@docker exec $(NETWORK_ENV_ARGS) $(CONTAINER_NAME) bash -c 'bash ./build.sh --stage deepcode-gui-tauri'

dev-deepcode-gui: _ensure_container
	@echo "[make] Docker 内启动 DeepCode-GUI 调试服务：http://127.0.0.1:$(DEEPCODE_HOST_PORT)/"
	@docker exec -it $(NETWORK_ENV_ARGS) $(CONTAINER_NAME) bash -c 'bash ./build.sh --stage deepcode-gui && DEEPCODE_HOST=0.0.0.0 DEEPCODE_PORT=$(DEEPCODE_CONTAINER_PORT) DEEPCODE_CLIENT_DIST=userspace/gui/dist-deepcode-gui cargo run -p deepcode-host-web'

# ---- clean：默认模式保持全量清理；worktree 模式只清理当前隔离资源 ----
clean:
	@echo "[make] 强制移除容器 $(CONTAINER_NAME) ..."
	-@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
ifeq ($(DEEPCODE_WORKTREE_MODE),0)
	@echo "[make] 强制移除镜像 $(IMAGE) ..."
	-@docker rmi -f $(IMAGE) >/dev/null 2>&1 || true
else
	@echo "[make] worktree 模式保留共享镜像 $(IMAGE)、pnpm store 和 Cargo registry"
endif
	@echo "[make] 移除 named volumes ..."
	-@for v in $(VOLUMES_ALL); do \
		docker volume rm $$v >/dev/null 2>&1 && echo "  - removed volume $$v" || echo "  - skip $$v (不存在)"; \
	done
	@echo "[make] 清理完成。下次 'make shell' 将重建当前配置需要的容器环境。"
	@echo "[make] 注意：宿主机 ./bin、./node_modules（如存在于宿主端）未被本目标修改。"
