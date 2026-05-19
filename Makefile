# ====================================================================
# DeepCode 开发容器入口 (Makefile)
# 仅暴露两个目标：
#   make shell  -> 进入容器（镜像/容器不存在则懒构建；运行中则 restart 刷新环境）
#   make clean  -> 全量清理（容器 + 镜像 + named volumes），下次 shell 全量重建
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
VOL_TAURI_TARGET      := deepcode-tauri-target
VOL_NODE_MODULES      := deepcode-node-modules
VOLUMES_ALL := $(VOL_PNPM_STORE) $(VOL_CARGO_REGISTRY) $(VOL_CARGO_TARGET) $(VOL_TAURI_TARGET) $(VOL_NODE_MODULES)

# ---- 容器运行参数 ----
# - $(CURDIR) 在 WSL 内自动为 /mnt/e/Dev-Agent/deepagent，挂载到容器 /workspace
# - named volumes 覆盖 node_modules / target，避免 Windows ↔ WSL ↔ 容器 IO 雪崩
RUN_ARGS := \
	--name $(CONTAINER_NAME) \
	--hostname deepcode-dev \
	-w $(WORKDIR_IN_CTNR) \
	-v $(CURDIR):$(WORKDIR_IN_CTNR) \
	-v $(VOL_PNPM_STORE):/root/.local/share/pnpm/store \
	-v $(VOL_CARGO_REGISTRY):/usr/local/cargo/registry \
	-v $(VOL_CARGO_TARGET):/workspace/target \
	-v $(VOL_TAURI_TARGET):/workspace/tauri/src-tauri/target \
	-v $(VOL_NODE_MODULES):/workspace/node_modules \
	-e CARGO_HOME=/usr/local/cargo \
	-e RUSTUP_HOME=/usr/local/rustup \
	-e PNPM_HOME=/root/.local/share/pnpm \
	-e PATH=/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

.PHONY: help shell clean _ensure_image _ensure_container

# ---- help：默认目标，列出可用入口 ----
help:
	@echo "DeepCode 开发容器入口"
	@echo ""
	@echo "  make shell   进入开发容器（容器存在则刷新重启后再 exec）"
	@echo "  make clean   全量清理（容器 + 镜像 + 5 个 named volumes），下次 shell 全量重建"
	@echo ""
	@echo "进入容器后可手动执行："
	@echo "  ./build.sh   编译并输出双平台产物到 bin/"
	@echo "  ./test.sh    运行链路 ping 与环境检查"

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
#   running     -> docker restart   (刷新环境)
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
		status=$$(docker container inspect -f '{{.State.Status}}' $(CONTAINER_NAME) 2>/dev/null | tr -d '[:space:]'); \
		case "$$status" in \
			running) \
				echo "[make] 容器 $(CONTAINER_NAME) 正在运行，restart 刷新环境..."; \
				docker restart $(CONTAINER_NAME) >/dev/null ; \
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
