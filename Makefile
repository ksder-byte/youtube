.PHONY: init up down logs build test lint

init:
	./setup.sh

# Build first: `up` then only waits for the YouTube session, not for apt.
up:
	docker compose build
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f bot

build:
	docker compose build

test:
	pytest -q
