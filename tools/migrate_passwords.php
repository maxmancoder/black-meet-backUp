<?php
// tools/migrate_passwords.php
// One-off CLI migration: bcrypt-hashes every plaintext password in users.
//
// Usage (from the project root):
//   php tools/migrate_passwords.php          # dry-run (reports only)
//   php tools/migrate_passwords.php --apply  # performs the migration
//
// Safe: rows already in bcrypt/argon format are skipped untouched.
// Users keep access because plaintext values hash to a verifiable bcrypt
// hash; login_email.php additionally upgrades stragglers transparently.

if (PHP_SAPI !== 'cli') { exit("CLI only\n"); }
require_once __DIR__ . '/../db.php';

$apply = in_array('--apply', $argv, true);

$pdo = db_connect();
$stmt = $pdo->query('SELECT id, username, password_hash FROM users');
$plaintext = 0; $hashed = 0; $migrated = 0;

while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
    $ph = (string)$row['password_hash'];
    if ($ph === '') { echo "SKIP id={$row['id']} ({$row['username']}): empty hash\n"; continue; }
    if (strpos($ph, '$2y$') === 0 || strpos($ph, '$2b$') === 0 || strpos($ph, '$argon') === 0) {
        $hashed++;
        continue;
    }
    $plaintext++;
    if ($apply) {
        $hash = password_hash($ph, PASSWORD_BCRYPT);
        $pdo->prepare('UPDATE users SET password_hash=? WHERE id=?')->execute([$hash, $row['id']]);
        $migrated++;
        echo "MIGRATED id={$row['id']} ({$row['username']})\n";
    } else {
        echo "WOULD MIGRATE id={$row['id']} ({$row['username']}) plaintext len=" . strlen($ph) . "\n";
    }
}

echo "----\n";
echo "already hashed : $hashed\n";
echo "plaintext found: $plaintext\n";
if ($apply) {
    echo "migrated       : $migrated\n";
} else {
    echo "(dry-run; re-run with --apply to migrate)\n";
}
