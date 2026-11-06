//! One remote host's connection, kept alive (M8): when the agent stream ends (EOF, ssh gone, a ping that gets no
//! answer) the link reports `Lost`, reconnects with backoff while repos there are watched, re-subscribes their
//! watchers and reports `Up` (the UI then reloads those tabs). Calls made while it is down fail fast; requests
//! in flight when it dropped already failed with "connection lost" (writes are never re-run).
use crate::{ChangeFn, PING_EVERY, PING_WAIT, Runner};
use commitkiwi_protocol::{Change, Req};
use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

pub type Connect = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Runner, String>> + Send>> + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub enum LinkEvent {
    /// The connection dropped; reconnecting (the reason, updated on each failed attempt).
    Lost(String),
    Up,
}
pub type StateFn = Arc<dyn Fn(LinkEvent) + Send + Sync>;

pub struct Link {
    connect: Connect,
    cur: AsyncMutex<Option<Arc<Runner>>>,
    /// Some while reconnecting: why it dropped
    lost: Mutex<Option<String>>,
    watched: Mutex<BTreeSet<String>>,
    on_change: ChangeFn,
    on_state: StateFn,
    /// first retry delay, doubling up to `max`
    min: Duration,
    max: Duration,
}

impl Link {
    pub fn new(connect: Connect, on_change: ChangeFn, on_state: StateFn) -> Arc<Self> {
        Self::with_backoff(connect, on_change, on_state, Duration::from_secs(1), Duration::from_secs(30))
    }

    pub fn with_backoff(connect: Connect, on_change: ChangeFn, on_state: StateFn, min: Duration, max: Duration) -> Arc<Self> {
        Arc::new(Link {
            connect, cur: AsyncMutex::new(None), lost: Mutex::new(None), watched: Mutex::default(), on_change, on_state, min, max,
        })
    }

    fn lost_now(&self) -> Option<String> {
        self.lost.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set_lost(&self, v: Option<String>) {
        *self.lost.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }

    fn watched(&self) -> Vec<String> {
        self.watched.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }

    /// The live runner, connecting on first use. While reconnecting: an error right away.
    pub async fn runner(self: &Arc<Self>) -> Result<Arc<Runner>, String> {
        if let Some(why) = self.lost_now() {
            return Err(format!("Disconnected, reconnecting… ({why})"));
        }
        let mut cur = self.cur.lock().await;
        if let Some(r) = cur.as_ref().filter(|r| r.alive()) {
            return Ok(r.clone());
        }
        // first use, or it died while nobody watched anything there: connect inline (concurrent callers wait)
        let r = Arc::new((self.connect)().await?);
        *cur = Some(r.clone());
        self.supervise(r.clone());
        Ok(r)
    }

    pub async fn watch(self: &Arc<Self>, repo: &str) -> Result<Option<String>, String> {
        self.watched.lock().unwrap_or_else(|e| e.into_inner()).insert(repo.into());
        self.runner().await?.watch(repo, self.on_change.clone()).await
    }

    pub async fn unwatch(self: &Arc<Self>, repo: &str) -> Result<(), String> {
        self.watched.lock().unwrap_or_else(|e| e.into_inner()).remove(repo);
        match self.runner().await {
            Ok(r) => r.unwatch(repo).await,
            Err(_) => Ok(()), // down: nothing is watching there anyway
        }
    }

    /// Watch `r` until it dies (pinging it), then reconnect.
    fn supervise(self: &Arc<Self>, r: Arc<Runner>) {
        let link = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = r.closed() => break,
                    _ = tokio::time::sleep(PING_EVERY) => {
                        // a stream that stays open but never answers (a hung network or agent) counts as dropped
                        if !matches!(tokio::time::timeout(PING_WAIT, r.call(Req::Hello)).await, Ok(Ok(_))) {
                            if let Runner::Remote(rem) = &*r { rem.kill(); }
                            r.closed().await;
                            break;
                        }
                    }
                }
            }
            let why = match &*r { Runner::Remote(rem) => rem.lost_reason(), Runner::Local => "connection lost".into() };
            {
                let mut cur = link.cur.lock().await;
                if !cur.as_ref().is_some_and(|c| Arc::ptr_eq(c, &r)) {
                    return; // replaced meanwhile
                }
                *cur = None;
            }
            drop(r);
            if link.watched().is_empty() {
                return; // no open tab there: the next call connects again
            }
            link.set_lost(Some(why.clone()));
            (link.on_state)(LinkEvent::Lost(why));
            link.reconnect().await;
        });
    }

    async fn reconnect(self: Arc<Self>) {
        let mut delay = self.min;
        loop {
            tokio::time::sleep(delay).await;
            if self.watched().is_empty() {
                self.set_lost(None);
                return;
            }
            match (self.connect)().await {
                Ok(r) => {
                    let r = Arc::new(r);
                    for repo in self.watched() {
                        let polling = match r.watch(&repo, self.on_change.clone()).await {
                            Ok(p) => p,
                            Err(e) => Some(e),
                        };
                        if let Some(reason) = polling {
                            (self.on_change)(Change { repo, refs: true, work: true, polling: Some(reason) });
                        }
                    }
                    *self.cur.lock().await = Some(r.clone());
                    self.set_lost(None);
                    self.supervise(r);
                    (self.on_state)(LinkEvent::Up);
                    return;
                }
                Err(e) => {
                    self.set_lost(Some(e.clone()));
                    (self.on_state)(LinkEvent::Lost(e));
                    delay = (delay * 2).min(self.max);
                }
            }
        }
    }
}
