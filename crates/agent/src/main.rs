//! Runs on the machine that owns the repos. `commitkiwi-agent --stdio` serves requests from stdin
//! (one thread per request, so a slow log never blocks a quick one) and writes replies to stdout.
use commitkiwi_core::Sink;
use commitkiwi_protocol::{MAGIC, Msg, Req, Resp, decode, encode, read_frame};
use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    if std::env::args().nth(1).as_deref() != Some("--stdio") {
        eprintln!("usage: commitkiwi-agent --stdio");
        std::process::exit(2);
    }
    let out = Arc::new(Mutex::new(io::stdout()));
    {
        let mut o = out.lock().unwrap_or_else(|e| e.into_inner());
        if o.write_all(MAGIC).and_then(|_| o.flush()).is_err() {
            return;
        }
    }
    let mut stdin = io::stdin().lock();
    // repo -> its watcher; `Changed` events go out with message id 0
    let watches: Arc<Mutex<HashMap<String, commitkiwi_core::watch::Watcher>>> = Arc::default();
    loop {
        let buf = match read_frame(&mut stdin) {
            Ok(Some(b)) => b,
            Ok(None) => return, // peer closed: exit quietly
            Err(e) => {
                eprintln!("agent: read failed: {e}");
                std::process::exit(1);
            }
        };
        let msg: Msg<Req> = match decode(&buf) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("agent: {e}");
                continue;
            }
        };
        // This loop keeps reading while requests run, so a `Cancel` reaches a busy job (core kills its git).
        let out = Arc::clone(&out);
        let watches = Arc::clone(&watches);
        thread::spawn(move || {
            let id = msg.id;
            let reply = match msg.body {
                Req::Watch { repo } => {
                    let events = Arc::clone(&out);
                    let on = Box::new(move |c| send(&events, &Msg { id: 0, body: Resp::Changed(c), ms: None }));
                    let polling = match commitkiwi_core::watch::watch(&repo, on) {
                        Ok(w) => { watches.lock().unwrap_or_else(|e| e.into_inner()).insert(repo, w); None }
                        Err(e) => { watches.lock().unwrap_or_else(|e| e.into_inner()).remove(&repo); Some(e) }
                    };
                    Resp::Watch { polling }
                }
                Req::Unwatch { repo } => {
                    watches.lock().unwrap_or_else(|e| e.into_inner()).remove(&repo);
                    Resp::Done
                }
                body => return run(&out, id, body),
            };
            send(&out, &Msg { id, body: reply, ms: None });
        });
    }
}

fn run(out: &Arc<Mutex<io::Stdout>>, id: u64, body: Req) {
    let events = Arc::clone(out);
    // a job's output goes back as `Output` frames with the job request's id, ahead of its reply
    let sink: Sink = Arc::new(move |text: &str| send(&events, &Msg { id, body: Resp::Output(text.into()), ms: None }));
    let t = std::time::Instant::now();
    let body = commitkiwi_core::handle_with(body, Some(sink));
    send(out, &Msg { id, body, ms: Some(t.elapsed().as_millis().min(u32::MAX as u128) as u32) });
}

fn send(out: &Mutex<io::Stdout>, m: &Msg<Resp>) {
    let bytes = encode(m);
    let mut o = out.lock().unwrap_or_else(|e| e.into_inner());
    if o.write_all(&bytes).and_then(|_| o.flush()).is_err() {
        std::process::exit(1); // stdout gone: nobody is listening
    }
}
