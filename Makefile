# Usage: make deploy D=01-crud-api
D ?=
# Private values stay out of git: copy .env.example to .env
-include .env
# Thumbnail demo needs sharp's linux binary, so build inside Docker
BUILD_FLAGS = $(if $(filter 03-s3-thumbnail,$(D)),--use-container,)
DEPLOY_FLAGS = $(if $(filter 05-sns-fanout,$(D)),--parameter-overrides NotifyEmail=$(DEMO_EMAIL),)$(if $(filter 06-daily-report,$(D)),--parameter-overrides SenderEmail=$(DEMO_EMAIL) RecipientEmail=$(DEMO_EMAIL),)

check:
	@test -n "$(D)" || (echo "set D=<demo folder>, e.g. make deploy D=01-crud-api" && exit 1)

build: check
	cd $(D) && sam build $(BUILD_FLAGS)

deploy: build
	cd $(D) && sam deploy $(DEPLOY_FLAGS)

logs: check
	cd $(D) && sam logs --tail

delete: check
	cd $(D) && sam delete --no-prompts

# Remove every demo stack (run after recording)
delete-all:
	@for d in 0*-*/; do echo "== $$d"; (cd $$d && sam delete --no-prompts) || true; done
