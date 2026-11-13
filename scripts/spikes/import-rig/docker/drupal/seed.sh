#!/usr/bin/env bash
# Synthetic fixtures for the import proof: public files, a private folder, nodes and two managed
# file rows. Nothing here is real data; every byte comes from /dev/urandom or a counter.
set -euo pipefail

ROOT=/opt/drupal/web
FILES="$ROOT/sites/default/files"
PRIVATE=/opt/drupal/private
COUNT="${SEED_FILES:-2500}"
SSH_USER="${SSH_USER:-tester}"

mkdir -p "$FILES/seed" "$PRIVATE/docs"
for i in $(seq 1 "$COUNT"); do
	d=$(printf '%02d' $((i % 25)))
	mkdir -p "$FILES/seed/$d"
	printf 'synthetic public file %s\n%s\n' "$i" "$(head -c 300 /dev/urandom | base64 -w0)" > "$FILES/seed/$d/file-$i.txt"
done
for i in $(seq 1 12); do
	printf 'synthetic private file %s\n%s\n' "$i" "$(head -c 300 /dev/urandom | base64 -w0)" > "$PRIVATE/docs/private-$i.txt"
done

chmod u+w "$ROOT/sites/default" "$ROOT/sites/default/settings.php"
grep -q "^\$settings\['file_private_path'\]" "$ROOT/sites/default/settings.php" \
	|| printf "\n\$settings['file_private_path'] = '../private';\n" >> "$ROOT/sites/default/settings.php"
chown -R "$SSH_USER:$SSH_USER" "$FILES" "$PRIVATE"

drush --root="$ROOT" php:eval '
	$pub = \Drupal\file\Entity\File::create(["uri" => "public://seed/00/file-25.txt", "filename" => "file-25.txt", "status" => 1]);
	$pub->save();
	$priv = \Drupal\file\Entity\File::create(["uri" => "private://docs/private-1.txt", "filename" => "private-1.txt", "status" => 1]);
	$priv->save();
	for ($n = 1; $n <= 40; $n++) {
		\Drupal\node\Entity\Node::create(["type" => "page", "title" => "seed node $n", "body" => ["value" => "synthetic body $n; with a semicolon;\nand a newline", "format" => "basic_html"]])->save();
	}
'
echo "[import-rig] seeded $COUNT public files, 12 private files, 41 nodes"
