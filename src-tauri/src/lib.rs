// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use std::{
    fs::{create_dir_all, OpenOptions},
    io::Write,
};

use tauri::Manager;

use crossbeam_channel::{unbounded, Sender};
use rodio::{buffer::SamplesBuffer, Decoder, OutputStream, Sink, Source};
use std::io::Cursor;
// use std::time::{Duration, Instant};

#[derive(Clone)]
struct AudioTx(Sender<AudioMsg>);

#[derive(Debug)]
enum AudioMsg {
    Sfx { kind: String, volume: f32 },
    BgmPlay { volume: f32 },
    BgmStop,
    BgmVolume { volume: f32 },
}

fn bgm_bytes() -> &'static [u8] {
    include_bytes!("../../assets/music/bgm.ogg")
}

fn sfx_bytes(kind: &str) -> Option<&'static [u8]> {
    match kind {
        "ui" => Some(include_bytes!("../../public/sfx/ui.wav")),
        "eat" => Some(include_bytes!("../../public/sfx/eat.wav")),
        "boost" => Some(include_bytes!("../../public/sfx/boost.wav")),
        "dash" => Some(include_bytes!("../../public/sfx/dash.wav")),
        "shield" => Some(include_bytes!("../../public/sfx/shield.wav")),
        "poison" => Some(include_bytes!("../../public/sfx/poison.wav")),
        "death" => Some(include_bytes!("../../public/sfx/death.wav")),
        _ => None,
    }
}

fn enemy_pickup_source() -> SamplesBuffer<f32> {
    // Procedural rival pickup sound: cyber "chirp" + sub click.
    // 48kHz mono.
    let sr: u32 = 48_000;
    let dur_s = 0.14_f32;
    let n = (dur_s * sr as f32) as usize;
    let mut out = Vec::with_capacity(n);

    for i in 0..n {
        let t = i as f32 / sr as f32;

        // envelope (fast attack, quick decay)
        let env = if t < 0.01 { t / 0.01 } else { ((dur_s - t) / (dur_s - 0.01)).max(0.0) };
        let env = env * env;

        // downward chirp
        let f0 = 820.0;
        let f1 = 260.0;
        let ft = f0 + (f1 - f0) * (t / dur_s);
        let phase = 2.0 * std::f32::consts::PI * ft * t;
        let chirp = phase.sin();

        // add a short sub click at the start
        let sub = if t < 0.03 {
            (2.0 * std::f32::consts::PI * 72.0 * t).sin() * (1.0 - t / 0.03)
        } else {
            0.0
        };

        // slight "digital" edge
        let edge = (chirp * 1.35).tanh();

        out.push((edge * 0.75 + sub * 0.45) * env);
    }

    SamplesBuffer::new(1, sr, out)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn append_log(app: tauri::AppHandle, lines: Vec<String>) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;

    create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let path = dir.join("ultimate-snake.log");

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open log: {e}"))?;

    for line in lines {
        writeln!(f, "{}", line).map_err(|e| format!("write log: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
fn play_sfx(state: tauri::State<'_, AudioTx>, kind: String, volume: f32, muted: bool) -> Result<(), String> {
    if muted || volume <= 0.0001 {
        return Ok(());
    }
    // send to audio thread (which owns OutputStream)
    state
        .0
        .send(AudioMsg::Sfx { kind, volume: volume.clamp(0.0, 1.5) })
        .map_err(|e| format!("send: {e}"))
}


#[tauri::command]
fn bgm_play(state: tauri::State<'_, AudioTx>, volume: f32, muted: bool) -> Result<(), String> {
    if muted || volume <= 0.0001 {
        return Ok(());
    }
    state.0.send(AudioMsg::BgmPlay { volume: volume.clamp(0.0, 1.0) }).map_err(|e| format!("send: {e}"))
}

#[tauri::command]
fn bgm_stop(state: tauri::State<'_, AudioTx>) -> Result<(), String> {
    state.0.send(AudioMsg::BgmStop).map_err(|e| format!("send: {e}"))
}

#[tauri::command]
fn bgm_volume(state: tauri::State<'_, AudioTx>, volume: f32, muted: bool) -> Result<(), String> {
    if muted {
        state.0.send(AudioMsg::BgmStop).map_err(|e| format!("send: {e}"))?;
        return Ok(());
    }
    state.0.send(AudioMsg::BgmVolume { volume: volume.clamp(0.0, 1.0) }).map_err(|e| format!("send: {e}"))
}

#[tauri::command]
fn log_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("ultimate-snake.log").to_string_lossy().to_string())
}

// Returns:
// - Ok(Some(msg)) when a message is received
// - Ok(None) when we timed out (used to wake up and restore BGM after duck)
// - Err(()) when channel is disconnected
// (kept around in case we re-introduce timed audio events later)
// fn recv_with_duck_wakeup(...) { ... }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Audio thread: owns OutputStream so we avoid Send/Sync issues.
    let (tx, rx) = unbounded::<AudioMsg>();
    std::thread::spawn(move || {
        let (_stream, handle) = match OutputStream::try_default() {
            Ok(v) => v,
            Err(e) => {
                eprintln!("audio OutputStream error: {e}");
                return;
            }
        };

        let mut bgm: Option<Sink> = None;
        let mut bgm_vol: f32 = 0.45;

        // One persistent SFX sink (reduces ALSA underruns + avoids per-sound sink creation overhead)
        let sfx_sink = match Sink::try_new(&handle) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("sfx Sink error: {e}");
                return;
            }
        };
        sfx_sink.set_volume(1.0);

        loop {
            let msg = match rx.recv() {
                Ok(m) => m,
                Err(_) => break,
            };

            match msg {
                AudioMsg::Sfx { kind, volume } => {
                    // Same volume behavior for you + rival.
                    let amp = volume.clamp(0.0, 2.0);

                    if kind == "enemy_pickup" {
                        let src = enemy_pickup_source();
                        sfx_sink.append(src.amplify(amp));
                        continue;
                    }

                    let bytes = match sfx_bytes(&kind) {
                        Some(b) => b,
                        None => continue,
                    };

                    let cur = Cursor::new(bytes);
                    let src = match Decoder::new(cur) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("audio Decoder error: {e}");
                            continue;
                        }
                    };

                    sfx_sink.append(src.amplify(amp));
                }
                AudioMsg::BgmPlay { volume } => {
                    bgm_vol = volume;
                    if bgm.is_none() {
                        let bytes = bgm_bytes();
                        let sink = match Sink::try_new(&handle) {
                            Ok(s) => s,
                            Err(e) => { eprintln!("bgm Sink error: {e}"); continue; }
                        };
                        sink.set_volume(bgm_vol);
                        let cur = Cursor::new(bytes);
                        let src = match Decoder::new(cur) {
                            Ok(s) => s,
                            Err(e) => { eprintln!("bgm Decoder error: {e}"); continue; }
                        };
                        sink.append(src.repeat_infinite());
                        bgm = Some(sink);
                    } else if let Some(s) = &bgm {
                        s.set_volume(volume);
                    }
                }
                AudioMsg::BgmVolume { volume } => {
                    bgm_vol = volume;
                    if let Some(s) = &bgm {
                        s.set_volume(bgm_vol);
                    }
                }
                AudioMsg::BgmStop => {
                    if let Some(s) = bgm.take() {
                        s.stop();
                    }
                }
            }
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AudioTx(tx))
        .invoke_handler(tauri::generate_handler![greet, append_log, log_path, play_sfx, bgm_play, bgm_stop, bgm_volume])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
