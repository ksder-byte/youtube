.PHONY: init up down logs build test

init:
	./setup.sh

# Build first, so `up` itself only takes seconds.
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
