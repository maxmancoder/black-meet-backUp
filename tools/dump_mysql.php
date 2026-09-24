<?php
// tools/dump_mysql.php - one-shot MySQL -> JSONL dump for the Node/SQLite import.
// Reads DB creds from ../config.json. Output: tools/mysql_dump/<table>.jsonl
$cfg = json_decode(file_get_contents(__DIR__ . '/../config.json'), true);
if (!$cfg || empty($cfg['db'])) { fwrite(STDERR, "config.json missing db block\n"); exit(1); }
$c = $cfg['db'];
$m = new mysqli($c['host'], $c['user'], $c['pass'], $c['name']);
if ($m->connect_errno) { fwrite(STDERR, "connect error: " . $m->connect_error . "\n"); exit(1); }
$m->set_charset('utf8mb4');

$tables = ['users','verification_codes','meetings','meeting_participants','messages',
           'emoji_events','meeting_blocks','pv_messages','announcements','migrations'];
$outDir = __DIR__ . '/mysql_dump';
if (!is_dir($outDir)) mkdir($outDir, 0777, true);

function clean($v) {
    if ($v === null) return null;
    if (is_string($v)) {
        $conv = @mb_convert_encoding($v, 'UTF-8', 'UTF-8');
        return ($conv !== false) ? $conv : $v;
    }
    return $v;
}

foreach ($tables as $t) {
    $res = $m->query("SELECT * FROM `$t`");
    if (!$res) { fwrite(STDERR, "SELECT $t failed: " . $m->error . "\n"); continue; }
    $fh = fopen("$outDir/$t.jsonl", 'w');
    $n = 0;
    while ($row = $res->fetch_assoc()) {
        fwrite($fh, json_encode(array_map('clean', $row), JSON_UNESCAPED_UNICODE) . "\n");
        $n++;
    }
    fclose($fh);
    $res->free();
    echo "$t: $n\n";
}
$m->close();
echo "done -> $outDir\n";