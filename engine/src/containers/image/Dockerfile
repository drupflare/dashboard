FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
FROM composer:2.9.8@sha256:b09bccd91a78fe8a9ab4b33d707b862e8fe54fec17782e32683ad2a69c46867d AS composer

FROM php:8.3-cli-bookworm@sha256:232331112d3a7c5b98edeeddc3b85f610172f99352c0635fe6b3e166e47062cb

RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		ca-certificates git unzip \
		libfreetype6 libjpeg62-turbo libpng16-16 libwebp7 libzip4 \
		libfreetype6-dev libjpeg62-turbo-dev libpng-dev libwebp-dev libzip-dev; \
	docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp; \
	docker-php-ext-install -j"$(nproc)" gd pdo_mysql zip; \
	apt-get purge -y --auto-remove \
		libfreetype6-dev libjpeg62-turbo-dev libpng-dev libwebp-dev libzip-dev; \
	rm -rf /var/lib/apt/lists/*; \
	useradd --create-home --uid 10001 job; \
	mkdir /work; \
	chown job /work

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=composer /usr/bin/composer /usr/local/bin/composer

RUN php -v | head -n 1; php -r 'exit(function_exists("gd_info") ? 0 : 1);'; node -v; composer --version

COPY server.mjs /srv/runner/server.mjs

USER job
ENV TMPDIR=/work
EXPOSE 8080
CMD ["node", "/srv/runner/server.mjs"]
