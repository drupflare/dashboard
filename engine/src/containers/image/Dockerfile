FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
FROM composer:2.9.8@sha256:b09bccd91a78fe8a9ab4b33d707b862e8fe54fec17782e32683ad2a69c46867d AS composer

FROM php:8.4-cli-trixie@sha256:d63e8b80cd4c6cfd01cfa7c910522e299cdc7ca1a2b6d6563db48df3c17e6c55

ADD https://github.com/mlocati/docker-php-extension-installer/releases/download/2.13.2/install-php-extensions /usr/local/bin/

RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		ca-certificates git unzip sqlite3 \
		libfreetype6 libjpeg62-turbo libpng16-16t64 libwebp7 libzip5 \
		libfreetype6-dev libjpeg62-turbo-dev libpng-dev libwebp-dev libzip-dev; \
	docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp; \
	docker-php-ext-install -j"$(nproc)" gd pdo_mysql zip; \
	apt-get purge -y --auto-remove \
		libfreetype6-dev libjpeg62-turbo-dev libpng-dev libwebp-dev libzip-dev; \
	chmod +x /usr/local/bin/install-php-extensions; \
	install-php-extensions exif bcmath geos; \
	echo 'memory_limit=-1' > /usr/local/etc/php/conf.d/zz-job.ini; \
	rm -rf /var/lib/apt/lists/*; \
	useradd --create-home --uid 10001 job; \
	mkdir /work; \
	chown job /work

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=composer /usr/bin/composer /usr/local/bin/composer

RUN php -v | head -n 1; \
	php -r 'exit(function_exists("gd_info") ? 0 : 1);'; \
	php -r 'foreach (["exif", "bcmath", "geos", "pdo_sqlite"] as $e) { if (!extension_loaded($e)) { fwrite(STDERR, "missing $e\n"); exit(1); } }'; \
	php -r 'exit(version_compare((new PDO("sqlite::memory:"))->query("select sqlite_version()")->fetchColumn(), "3.45", ">=") ? 0 : 1);'; \
	sqlite3 --version; node -v; composer --version

COPY server.mjs template-build.mjs /srv/runner/

USER job
ENV TMPDIR=/work
EXPOSE 8080
CMD ["node", "/srv/runner/server.mjs"]
