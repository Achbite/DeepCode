# ====================================================================
# DeepCode 开发容器入口 (Makefile)
# 主要目标：
#   make shell          -> 进入容器（镜像/容器不存在则懒构建；运行中则 restart 刷新环境）
#   make build-deepcode-gui -> 在 Docker 内构建 Codex 风 DeepCode-GUI dist
#   make dev-deepcode-gui   -> 在 Docker 内启动 31246 DeepCode-GUI 调试服务
#   make clean          -> 全量清理（容器 + 镜像 + named volumes），下次 shell 全量重建
#   make package-macos  -> 在 macOS 宿主机上生成 Darwin GUI/TUI 本机包
#   make package-macos-deepcode-gui -> 在 macOS 宿主机上生成 bin/macos-arm64/DeepCode-GUI.app
#
# 适用环境：Linux / macOS / WSL（必须能直连 Docker daemon）
# 不支持：Windows 原生 PowerShell 直接调用（请先 wsl 进入 Linux 子系统）
# ====================================================================

# ---- 基础常量（与项目结构强绑定）----
IMAGE_NAME       := deepcode-dev
IMAGE_TAG        := latest
IMAGE            := $(IMAGE_NAME):$(IMAGE_TAG)
CONTAINER_NAME   := deepcode-dev
DOCKERFILE       := Dockerfile.dev
WORKDIR_IN_CTNR  := /workspace

# ---- 持久化卷（只有 make clean 才会清空，避免每次 shell 重装依赖）----
VOL_PNPM_STORE        := deepcode-pnpm-store
VOL_CARGO_REGISTRY    := deepcode-cargo-registry
VOL_CARGO_TARGET      := deepcode-cargo-target
VOL_NODE_MODULES      := deepcode-node-modules
VOLUMES_ALL := $(VOL_PNPM_STORE) $(VOL_CARGO_REGISTRY) $(VOL_CARGO_TARGET) $(VOL_NODE_MODULES)

# ---- 容器运行参数 ----
# - $(CURDIR) 在 WSL 内自动为 /mnt/e/Dev-Agent/deepagent，挂载到容器 /workspace
# - named volumes 覆盖 node_modules / target，避免 Windows ↔ WSL ↔ 容器 IO 雪崩
RUN_ARGS := \
	--name $(CONTAINER_NAME) \
	--hostname deepcode-dev \
	-w $(WORKDIR_IN_CTNR) \
	-p 127.0.0.1:31246:31246 \
	-v $(CURDIR):$(WORKDIR_IN_CTNR) \
	-v $(VOL_PNPM_STORE):/root/.local/share/pnpm/store \
	-v $(VOL_CARGO_REGISTRY):/usr/local/cargo/registry \
	-v $(VOL_CARGO_TARGET):/workspace/target \
	-v $(VOL_NODE_MODULES):/workspace/node_modules \
	-e CARGO_HOME=/usr/local/cargo \
	-e RUSTUP_HOME=/usr/local/rustup \
	-e PNPM_HOME=/root/.local/share/pnpm \
	-e PATH=/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

.PHONY: help shell build-deepcode-gui dev-deepcode-gui clean package-macos package-macos-deepcode-gui _ensure_image _ensure_container

# ---- help：默认目标，列出可用入口 ----
help:
	@echo "DeepCode 开发容器入口"
	@echo ""
	@echo "  make shell          进入开发容器（容器存在则刷新重启后再 exec）"
	@echo "  make build-deepcode-gui  在 Docker 内构建 Codex 风 DeepCode-GUI dist"
	@echo "  make dev-deepcode-gui    在 Docker 内启动 DeepCode-GUI 调试服务：127.0.0.1:31246"
	@echo "  make clean          全量清理（容器 + 镜像 + 4 个 named volumes），下次 shell 全量重建"
	@echo "  make package-macos  在 macOS 宿主机上生成 bin/macos-arm64 GUI/TUI 本机包"
	@echo "  make package-macos-deepcode-gui  在 macOS 宿主机上生成 bin/macos-arm64/DeepCode-GUI.app"
	@echo ""
	@echo "进入容器后可手动执行："
	@echo "  ./build.sh   编译并输出统一分发目录到 bin/deepcode/"
	@echo "  ./test.sh    运行链路 ping 与环境检查"

package-macos:
	@bash ./scripts/package-macos.sh

package-macos-deepcode-gui: build-deepcode-gui
	@DEEPCODE_MACOS_PRODUCT=DeepCode-GUI bash ./scripts/package-macos.sh

# ---- _ensure_image：镜像不存在则构建 ----
_ensure_image:
	@if ! docker image inspect $(IMAGE) >/dev/null 2>&1; then \
		echo "[make] 镜像 $(IMAGE) 不存在，开始构建..."; \
		docker build -f $(DOCKERFILE) -t $(IMAGE) . ; \
	else \
		echo "[make] 镜像 $(IMAGE) 已存在，跳过构建"; \
	fi

# ---- _ensure_container：容器懒创建 / 刷新启动 ----
# 状态机：
#   not exists  -> docker run -d
#   running     -> reuse            (避免构建/打包阶段杀掉 31246 调试服务)
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
		port_bindings=$$(docker container inspect -f '{{json .NetworkSettings.Ports}}' $(CONTAINER_NAME) 2>/dev/null); \
		if ! printf '%s\n' "$$port_bindings" | grep -q '"31246/tcp"'; then \
			echo "[make] 容器 $(CONTAINER_NAME) 缺少 31246 端口映射，重建容器并保留 named volumes..."; \
			docker rm -f $(CONTAINER_NAME) >/dev/null ; \
			docker run -d $(RUN_ARGS) $(IMAGE) /usr/local/bin/entrypoint.sh >/dev/null ; \
			exit 0 ; \
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
shell: _ensure_container
	@echo "[make] exec 进入容器 $(CONTAINER_NAME) ..."
	@docker exec -it $(CONTAINER_NAME) bash

build-deepcode-gui: _ensure_container
	@echo "[make] Docker 内构建 DeepCode-GUI dist ..."
	@docker exec $(CONTAINER_NAME) bash -c 'bash ./build.sh --stage deepcode-gui'

dev-deepcode-gui: _ensure_container
	@echo "[make] Docker 内启动 DeepCode-GUI 调试服务：http://127.0.0.1:31246/"
	@docker exec -it $(CONTAINER_NAME) bash -c 'bash ./build.sh --stage deepcode-gui && DEEPCODE_HOST=0.0.0.0 DEEPCODE_PORT=31246 DEEPCODE_CLIENT_DIST=userspace/gui/dist-deepcode-gui cargo run -p deepcode-host-web'

# ---- clean：全量清理 ----
clean:
	@echo "[make] 强制移除容器 $(CONTAINER_NAME) ..."
	-@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	@echo "[make] 强制移除镜像 $(IMAGE) ..."
	-@docker rmi -f $(IMAGE) >/dev/null 2>&1 || true
	@echo "[make] 移除 named volumes ..."
	-@for v in $(VOLUMES_ALL); do \
		docker volume rm $$v >/dev/null 2>&1 && echo "  - removed volume $$v" || echo "  - skip $$v (不存在)"; \
	done
	@echo "[make] 清理完成。下次 'make shell' 将全量重建镜像与容器。"
	@echo "[make] 注意：宿主机 ./bin、./node_modules（如存在于宿主端）未被本目标修改。"
