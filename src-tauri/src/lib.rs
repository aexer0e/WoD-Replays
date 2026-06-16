use std::{
    collections::HashMap,
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

use base64::{engine::general_purpose, Engine as _};
use flate2::read::GzDecoder;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

const FPS: f64 = 30.0;
const GAME_DIR_NAME: &str = "War of Dots";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerSummary {
    name: String,
    team_index: usize,
    winner: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaySummary {
    file_name: String,
    players: Vec<PlayerSummary>,
    length: String,
    duration_seconds: u64,
    thumbnail_data_url: Option<String>,
    modified: u64,
}

struct ParsedReplay {
    summary: ReplaySummary,
    result: Option<Value>,
    event_winner_index: Option<usize>,
    map_id: Option<String>,
    custom_map_surface: Option<String>,
}

#[tauri::command]
fn list_replays(_app: AppHandle) -> Result<Vec<ReplaySummary>, String> {
    let replay_dirs = discover_replay_dirs();
    if replay_dirs.is_empty() {
        return Ok(Vec::new());
    }

    let mut map_cache = HashMap::new();
    let mut parsed_replays = Vec::new();

    for replay_dir in replay_dirs {
        let entries = fs::read_dir(&replay_dir).map_err(|error| {
            format!(
                "Could not read replay folder {}: {error}",
                replay_dir.display()
            )
        })?;

        for entry in entries.flatten() {
            let path = entry.path();
            if !is_replay_file(&path) {
                continue;
            }

            match parse_replay(&path) {
                Ok(mut parsed) => {
                    parsed.summary.thumbnail_data_url =
                        thumbnail_for_replay(&replay_dir, &parsed, &mut map_cache);
                    parsed_replays.push(parsed);
                }
                Err(error) => {
                    eprintln!("Skipping {}: {error}", path.display());
                }
            }
        }
    }

    let home_player = detect_home_player(&parsed_replays);
    let mut replays = parsed_replays
        .into_iter()
        .map(|mut parsed| {
            let winner_index = replay_winner_index(
                parsed.result.as_ref(),
                &parsed.summary.players,
                home_player.as_deref(),
            )
            .or(parsed.event_winner_index);
            mark_winner(&mut parsed.summary.players, winner_index);

            if let Some(home_player) = home_player.as_deref() {
                put_home_player_first(&mut parsed.summary.players, home_player);
            }
            parsed.summary
        })
        .collect::<Vec<_>>();

    replays.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });

    Ok(replays)
}

fn discover_replay_dirs() -> Vec<PathBuf> {
    discover_steamapps_dirs()
        .into_iter()
        .map(|steamapps| steamapps.join("common").join(GAME_DIR_NAME).join("replays"))
        .filter(|path| path.is_dir())
        .fold(Vec::new(), |mut replay_dirs, path| {
            push_unique_path(&mut replay_dirs, path);
            replay_dirs
        })
}

fn discover_steamapps_dirs() -> Vec<PathBuf> {
    let mut steam_roots = discover_steam_roots();
    let mut steamapps_dirs = Vec::new();

    for root in &steam_roots {
        push_steamapps_candidate(&mut steamapps_dirs, root);
    }

    for root in steam_roots.drain(..) {
        let library_config = root.join("steamapps").join("libraryfolders.vdf");
        let Ok(config) = fs::read_to_string(library_config) else {
            continue;
        };

        for library_root in parse_steam_library_paths(&config) {
            push_steamapps_candidate(&mut steamapps_dirs, &library_root);
        }
    }

    for drive in b'A'..=b'Z' {
        let drive_root = format!("{}:\\", drive as char);
        for candidate in [
            PathBuf::from(&drive_root).join("Steam"),
            PathBuf::from(&drive_root).join("SteamLibrary"),
        ] {
            push_steamapps_candidate(&mut steamapps_dirs, &candidate);
        }
    }

    steamapps_dirs
}

fn discover_steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    #[cfg(windows)]
    for root in registry_steam_roots() {
        push_unique_path(&mut roots, root);
    }

    for var_name in ["STEAM_DIR", "STEAM_PATH", "SteamPath"] {
        if let Some(path) = env::var_os(var_name) {
            push_unique_path(&mut roots, PathBuf::from(path));
        }
    }

    for var_name in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(path) = env::var_os(var_name) {
            push_unique_path(&mut roots, PathBuf::from(path).join("Steam"));
        }
    }

    if let Some(system_drive) = env::var_os("SystemDrive") {
        push_unique_path(&mut roots, PathBuf::from(system_drive).join("Steam"));
    }

    push_unique_path(&mut roots, PathBuf::from(r"C:\Steam"));
    roots
}

#[cfg(windows)]
fn registry_steam_roots() -> Vec<PathBuf> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
        RegKey,
    };

    let mut roots = Vec::new();
    let probes = [
        (HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Valve\Steam",
            "InstallPath",
        ),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
    ];

    for (hive, key_path, value_name) in probes {
        let key = RegKey::predef(hive);
        let Ok(steam_key) = key.open_subkey(key_path) else {
            continue;
        };
        let Ok(value) = steam_key.get_value::<String, _>(value_name) else {
            continue;
        };

        push_unique_path(&mut roots, PathBuf::from(value.replace('/', r"\")));
    }

    roots
}

fn push_steamapps_candidate(steamapps_dirs: &mut Vec<PathBuf>, candidate: &Path) {
    if candidate
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("steamapps"))
        && candidate.is_dir()
    {
        push_unique_path(steamapps_dirs, candidate.to_path_buf());
        return;
    }

    let steamapps = candidate.join("steamapps");
    if steamapps.is_dir() {
        push_unique_path(steamapps_dirs, steamapps);
    }
}

fn parse_steam_library_paths(config: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    for line in config.lines() {
        let quoted = quoted_vdf_values(line);
        if quoted.len() < 2 {
            continue;
        }

        let path = if quoted[0] == "path" {
            Some(&quoted[1])
        } else if quoted[0].parse::<usize>().is_ok() && looks_like_path(&quoted[1]) {
            Some(&quoted[1])
        } else {
            None
        };

        if let Some(path) = path {
            push_unique_path(&mut paths, PathBuf::from(path.replace('/', r"\")));
        }
    }

    paths
}

fn quoted_vdf_values(line: &str) -> Vec<String> {
    line.split('"')
        .enumerate()
        .filter_map(|(index, value)| {
            (index % 2 == 1).then(|| value.replace(r"\\", r"\").replace(r#"\""#, r#"""#))
        })
        .collect()
}

fn looks_like_path(value: &str) -> bool {
    value.contains(":\\") || value.contains(":/") || value.starts_with(r"\\")
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    let key = path_key(&path);
    if paths.iter().any(|existing| path_key(existing) == key) {
        return;
    }

    paths.push(path);
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', r"\")
        .to_ascii_lowercase()
}

fn detect_home_player(replays: &[ParsedReplay]) -> Option<String> {
    let mut counts: HashMap<String, (usize, String)> = HashMap::new();

    for replay in replays {
        for player in &replay.summary.players {
            if is_fallback_player_name(&player.name) {
                continue;
            }

            let key = player.name.to_ascii_lowercase();
            let entry = counts.entry(key).or_insert((0, player.name.clone()));
            entry.0 += 1;
        }
    }

    let mut counts = counts.into_iter().collect::<Vec<_>>();
    counts.sort_by(
        |(_, (left_count, left_name)), (_, (right_count, right_name))| {
            right_count
                .cmp(left_count)
                .then_with(|| left_name.cmp(right_name))
        },
    );

    counts.into_iter().next().map(|(key, _)| key)
}

fn is_fallback_player_name(name: &str) -> bool {
    let Some(number) = name.strip_prefix("Player ") else {
        return false;
    };

    number.parse::<usize>().is_ok()
}

fn put_home_player_first(players: &mut [PlayerSummary], home_player: &str) {
    if let Some(index) = players
        .iter()
        .position(|player| player.name.eq_ignore_ascii_case(home_player))
    {
        players.swap(0, index);
    }
}

fn is_replay_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "rep" | "json"))
        .unwrap_or(false)
}

fn parse_replay(path: &Path) -> Result<ParsedReplay, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let json_bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(bytes.as_slice());
        let mut decoded = Vec::new();
        decoder
            .read_to_end(&mut decoded)
            .map_err(|error| error.to_string())?;
        decoded
    } else {
        bytes
    };

    let raw: Value = serde_json::from_slice(&json_bytes).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("replay")
        .to_string();
    let modified = path
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(system_time_to_secs)
        .unwrap_or(0);
    let names = replay_player_names(&raw);
    let players: Vec<PlayerSummary> = names
        .into_iter()
        .enumerate()
        .map(|(team_index, name)| PlayerSummary {
            name,
            team_index,
            winner: false,
        })
        .collect();

    let end_frame = replay_end_frame(&raw);
    let duration_seconds = duration_seconds(end_frame);
    let event_winner_index = replay_event_winner_index(&raw, players.len());

    Ok(ParsedReplay {
        summary: ReplaySummary {
            file_name,
            players,
            length: format_duration_seconds(duration_seconds),
            duration_seconds,
            thumbnail_data_url: None,
            modified,
        },
        result: raw.get("result").cloned(),
        event_winner_index,
        map_id: replay_map_id(&raw),
        custom_map_surface: custom_map_surface(&raw),
    })
}

fn replay_player_names(raw: &Value) -> Vec<String> {
    let mut names = raw
        .get("player_usernames")
        .and_then(Value::as_array)
        .map(|players| {
            players
                .iter()
                .take(4)
                .enumerate()
                .map(|(index, name)| clean_player_name(&flatten_name(name), index))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    while names.len() < 2 {
        names.push(fallback_player_name(names.len()));
    }

    names
}

fn flatten_name(value: &Value) -> String {
    match value {
        Value::Array(values) => values
            .iter()
            .map(flatten_name)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" / "),
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null | Value::Object(_) => String::new(),
    }
}

fn clean_player_name(name: &str, index: usize) -> String {
    let trimmed = name.trim();
    let without_badge = trimmed
        .rfind(" [")
        .filter(|_| trimmed.ends_with(']'))
        .map(|index| &trimmed[..index])
        .unwrap_or(trimmed)
        .trim();

    if without_badge.is_empty() {
        fallback_player_name(index)
    } else {
        without_badge.to_string()
    }
}

fn fallback_player_name(index: usize) -> String {
    format!("Player {}", index + 1)
}

fn mark_winner(players: &mut [PlayerSummary], winner_index: Option<usize>) {
    for (index, player) in players.iter_mut().enumerate() {
        player.winner = winner_index == Some(index);
    }
}

fn replay_winner_index(
    result: Option<&Value>,
    players: &[PlayerSummary],
    home_player: Option<&str>,
) -> Option<usize> {
    let result = result?;

    if let Some(index) = result_player_name_index(result, players) {
        return Some(index);
    }

    if let Some(home_player) = home_player {
        if let Some(home_won) = result_home_outcome(result) {
            if let Some(index) = winner_from_home_outcome(home_won, players, home_player) {
                return Some(index);
            }
        }
    }

    result_player_index(result, players)
}

fn result_player_name_index(result: &Value, players: &[PlayerSummary]) -> Option<usize> {
    let text = result.as_str()?;
    let normalized = clean_player_name(text, 0).to_ascii_lowercase();

    players
        .iter()
        .position(|player| player.name.to_ascii_lowercase() == normalized)
}

fn result_home_outcome(result: &Value) -> Option<bool> {
    if let Some(flag) = result.as_bool() {
        return Some(flag);
    }

    if let Some(index) = result.as_i64() {
        return match index {
            1 => Some(true),
            0 => Some(false),
            _ => None,
        };
    }

    let text = result.as_str()?.trim().to_ascii_lowercase();
    match text.as_str() {
        "1" | "true" | "win" | "won" | "winner" | "victory" => Some(true),
        "0" | "false" | "loss" | "lost" | "lose" | "defeat" => Some(false),
        _ => None,
    }
}

fn winner_from_home_outcome(
    home_won: bool,
    players: &[PlayerSummary],
    home_player: &str,
) -> Option<usize> {
    let home_index = players
        .iter()
        .position(|player| player.name.eq_ignore_ascii_case(home_player))?;

    if home_won {
        return Some(home_index);
    }

    (players.len() == 2).then_some(1 - home_index)
}

fn result_player_index(result: &Value, players: &[PlayerSummary]) -> Option<usize> {
    if let Some(index) = result.as_i64() {
        if index == -1 && players.len() == 2 {
            return Some(1);
        }

        return usize::try_from(index)
            .ok()
            .filter(|index| *index < players.len());
    }

    let text = result.as_str()?;
    let index = text.parse::<i64>().ok()?;
    if index == -1 && players.len() == 2 {
        return Some(1);
    }

    usize::try_from(index)
        .ok()
        .filter(|index| *index < players.len())
}

fn replay_event_winner_index(raw: &Value, player_count: usize) -> Option<usize> {
    if player_count != 2 {
        return None;
    }

    production_zone_winner_index(raw, player_count)
}

fn production_zone_winner_index(raw: &Value, player_count: usize) -> Option<usize> {
    let end_frame = replay_end_frame(raw);
    let mut best_recent: Option<ProductionZoneCandidate> = None;
    let mut best_overall: Option<ProductionZoneCandidate> = None;

    let Some(object) = raw.as_object() else {
        return None;
    };

    for (frame_key, frame_value) in object {
        let Ok(frame) = frame_key.parse::<f64>() else {
            continue;
        };
        let Some(frame_events) = frame_value.as_object() else {
            continue;
        };

        for (event_key, event_value) in frame_events {
            let Some(index) = production_player_index(event_key, player_count) else {
                continue;
            };
            let Some(zones) = event_value
                .get("zone")
                .and_then(Value::as_array)
                .map(Vec::len)
                .filter(|zones| *zones > 0)
            else {
                continue;
            };

            let candidate = ProductionZoneCandidate {
                index,
                frame,
                zones,
            };

            push_better_zone_candidate(&mut best_overall, candidate);

            if end_frame <= 0.0 || end_frame - frame <= FPS * 90.0 {
                push_better_zone_candidate(&mut best_recent, candidate);
            }
        }
    }

    best_recent.or(best_overall).map(|candidate| candidate.index)
}

#[derive(Clone, Copy)]
struct ProductionZoneCandidate {
    index: usize,
    frame: f64,
    zones: usize,
}

fn production_player_index(key: &str, player_count: usize) -> Option<usize> {
    let index = key.strip_prefix("production")?.parse::<usize>().ok()?;
    (index < player_count).then_some(index)
}

fn push_better_zone_candidate(
    best: &mut Option<ProductionZoneCandidate>,
    candidate: ProductionZoneCandidate,
) {
    let is_better = match best {
        Some(current) => {
            candidate.zones > current.zones
                || (candidate.zones == current.zones && candidate.frame > current.frame)
        }
        None => true,
    };

    if is_better {
        *best = Some(candidate);
    }
}

fn replay_end_frame(raw: &Value) -> f64 {
    raw.get("end").and_then(Value::as_f64).unwrap_or_else(|| {
        raw.as_object()
            .map(|object| {
                object
                    .keys()
                    .filter_map(|key| key.parse::<f64>().ok())
                    .fold(0.0, f64::max)
            })
            .unwrap_or(0.0)
    })
}

fn duration_seconds(frame: f64) -> u64 {
    (frame / FPS).floor().max(0.0) as u64
}

fn format_duration_seconds(total_seconds: u64) -> String {
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes:02}:{seconds:02}")
}

fn replay_map_id(raw: &Value) -> Option<String> {
    let map = raw.get("map")?;
    let id = match map {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };

    (!id.is_empty() && id != "custom").then_some(id)
}

fn custom_map_surface(raw: &Value) -> Option<String> {
    raw.get("custom_map")
        .and_then(|custom_map| custom_map.get("map_surface"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|surface| !surface.is_empty())
        .map(ToOwned::to_owned)
}

fn thumbnail_for_replay(
    replay_dir: &Path,
    replay: &ParsedReplay,
    map_cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    if let Some(surface) = replay.custom_map_surface.as_deref() {
        if surface.starts_with("data:image/") {
            return Some(surface.to_string());
        }

        return Some(format!("data:image/png;base64,{surface}"));
    }

    let map_id = replay.map_id.as_deref()?;
    let game_root = game_root_from_replay_dir(replay_dir)?;
    let cache_key = format!("{}|{map_id}", path_key(game_root));
    if let Some(cached) = map_cache.get(&cache_key) {
        return cached.clone();
    }

    let data_url = map_image_data_url(game_root, map_id);
    map_cache.insert(cache_key, data_url.clone());
    data_url
}

fn game_root_from_replay_dir(replay_dir: &Path) -> Option<&Path> {
    replay_dir.parent()
}

fn map_image_data_url(game_root: &Path, map_id: &str) -> Option<String> {
    let safe_map_id = map_id
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect::<String>();
    if safe_map_id.is_empty() {
        return None;
    }

    let file_name = format!("map{safe_map_id}.png");
    let path = game_root
        .join("assets")
        .join("fahero_maps")
        .join(file_name);
    let bytes = fs::read(path).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

fn system_time_to_secs(time: SystemTime) -> Option<u64> {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_replays])
        .run(tauri::generate_context!())
        .expect("error while running WoD Replays");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn players(names: &[&str]) -> Vec<PlayerSummary> {
        names
            .iter()
            .enumerate()
            .map(|(team_index, name)| PlayerSummary {
                name: (*name).to_string(),
                team_index,
                winner: false,
            })
            .collect()
    }

    #[test]
    fn numeric_win_marks_home_player_when_home_is_first() {
        let players = players(&["aexer0e", "forkhoifor"]);

        assert_eq!(
            replay_winner_index(Some(&json!(1)), &players, Some("aexer0e")),
            Some(0)
        );
    }

    #[test]
    fn numeric_win_marks_home_player_when_home_is_second() {
        let players = players(&["forkhoifor", "aexer0e"]);

        assert_eq!(
            replay_winner_index(Some(&json!(1)), &players, Some("aexer0e")),
            Some(1)
        );
    }

    #[test]
    fn numeric_loss_marks_only_opponent_in_one_versus_one() {
        let players = players(&["aexer0e", "forkhoifor"]);

        assert_eq!(
            replay_winner_index(Some(&json!(0)), &players, Some("aexer0e")),
            Some(1)
        );
    }

    #[test]
    fn boolean_win_marks_home_player_not_player_two() {
        let players = players(&["aexer0e", "johned"]);

        assert_eq!(
            replay_winner_index(Some(&json!(true)), &players, Some("aexer0e")),
            Some(0)
        );
    }

    #[test]
    fn numeric_index_still_works_without_home_player() {
        let players = players(&["blue", "red", "orange"]);

        assert_eq!(
            replay_winner_index(Some(&json!(2)), &players, None),
            Some(2)
        );
    }

    #[test]
    fn numeric_index_works_when_detected_home_player_is_absent() {
        let players = players(&["matingmaverick", "mykfree"]);

        assert_eq!(
            replay_winner_index(Some(&json!(1)), &players, Some("aexer0e")),
            Some(1)
        );
    }

    #[test]
    fn negative_one_marks_second_player_in_one_versus_one() {
        let players = players(&["unknownerror", "girthmcslammer"]);

        assert_eq!(
            replay_winner_index(Some(&json!(-1)), &players, Some("aexer0e")),
            Some(1)
        );
    }

    #[test]
    fn production_zone_fallback_marks_recent_zone_owner() {
        let replay = json!({
            "900": {
                "production0": { "color": 0, "rate": 1, "ratio": 1 }
            },
            "1200": {
                "production1": { "color": 1, "zone": [2, 3, 5, 8] }
            },
            "end": 1230
        });

        assert_eq!(replay_event_winner_index(&replay, 2), Some(1));
    }

    #[test]
    fn map_image_uses_exact_fahero_map_file() {
        let suffix = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let game_root = env::temp_dir().join(format!("wod-replays-map-test-{suffix}"));
        let map_dir = game_root.join("assets").join("fahero_maps");
        fs::create_dir_all(&map_dir).unwrap();
        fs::write(map_dir.join("map31.png"), b"map31").unwrap();

        assert_eq!(
            map_image_data_url(&game_root, "31"),
            Some("data:image/png;base64,bWFwMzE=".to_string())
        );
        assert_eq!(map_image_data_url(&game_root, "100"), None);

        let _ = fs::remove_dir_all(game_root);
    }
}
