// Confirmation dialogs for destructive actions. Names are read from data
// attributes (already HTML-escaped by the template), never interpolated into
// inline JavaScript.
document.addEventListener("submit", function (event) {
  var form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.confirm) {
    return;
  }
  var name = form.dataset.name || "";
  if (!window.confirm(form.dataset.confirm.replace("{name}", name))) {
    event.preventDefault();
  }
});

// Optional change watcher: long-poll /api/changes with the last version we
// received as the cursor and render the net change set.  Purely additive; the
// page works without JavaScript.
(function () {
  var section = document.querySelector("[data-change-watch]");
  if (!section) {
    return;
  }
  var endpoint = section.dataset.endpoint;
  var version = parseInt(section.dataset.version, 10);
  var toggle = section.querySelector("[data-watch-toggle]");
  var status = section.querySelector("[data-watch-status]");
  var log = section.querySelector("[data-change-log]");
  var badge = section.querySelector("[data-watch-version]");
  var active = false;
  var backoff = 1000;
  var directory = document.querySelector("[data-directory]");
  var stateEndpoint = directory ? directory.dataset.stateEndpoint : null;
  var dirBadge = directory ? directory.querySelector("[data-dir-badge]") : null;
  var dirRows = directory ? directory.querySelector("[data-dir-rows]") : null;
  var deleteBase = directory ? directory.dataset.deleteBase || "" : "";

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = "small " + (kind || "muted");
  }

  function describe(changes) {
    var lines = [];
    (changes.added || []).forEach(function (row) {
      lines.push("+ " + row.service + " -> " + row.address);
    });
    (changes.updated || []).forEach(function (row) {
      lines.push("~ " + row.service + ": " + row.old_address + " -> " + row.address);
    });
    (changes.removed || []).forEach(function (row) {
      lines.push("- " + row.service + " (" + row.address + ")");
    });
    return lines;
  }

  function render(changes) {
    var lines = describe(changes);
    log.textContent = "";
    if (!lines.length) {
      var empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "目录内容回到与游标相同（版本仍已前进）";
      log.appendChild(empty);
      return;
    }
    lines.forEach(function (line) {
      var item = document.createElement("li");
      item.textContent = line;
      log.appendChild(item);
    });
  }

  function schedule(fn, ms) {
    return window.setTimeout(function () {
      if (active) {
        fn();
      }
    }, ms);
  }

  // The change feed is a diff, so after showing it we refresh the rendered
  // directory from /api/state to keep the table and the version badge in sync.
  function refreshDirectory(next) {
    if (!directory || !stateEndpoint) {
      return Promise.resolve();
    }
    return fetch(stateEndpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(function (resp) {
        return resp.ok ? resp.json() : null;
      })
      .then(function (state) {
        if (!state || state.version !== next || !dirRows || !dirBadge) {
          return;
        }
        dirBadge.textContent = "版本 " + state.version + " · " + state.count + " 项";
        while (dirRows.firstChild) {
          dirRows.removeChild(dirRows.firstChild);
        }
        state.services.forEach(function (row) {
          var tr = document.createElement("tr");
          var name = document.createElement("td");
          name.className = "mono";
          name.textContent = row.service;
          var address = document.createElement("td");
          address.className = "mono";
          address.textContent = row.address;
          var actions = document.createElement("td");
          actions.className = "right";
          if (deleteBase) {
            var form = document.createElement("form");
            form.method = "post";
            form.action = deleteBase.replace(
              "__SERVICE__",
              encodeURIComponent(row.service)
            );
            form.dataset.confirm = "确认删除 {name}？";
            form.dataset.name = row.service;
            var button = document.createElement("button");
            button.type = "submit";
            button.className = "danger";
            button.textContent = "删除";
            form.appendChild(button);
            actions.appendChild(form);
          }
          tr.appendChild(name);
          tr.appendChild(address);
          tr.appendChild(actions);
          dirRows.appendChild(tr);
        });
        if (!state.services.length) {
          var empty = document.createElement("tr");
          empty.dataset.dirEmpty = "";
          var cell = document.createElement("td");
          cell.colSpan = 3;
          cell.className = "muted";
          cell.textContent = "目录为空。请在下方添加服务。";
          empty.appendChild(cell);
          dirRows.appendChild(empty);
        }
      })
      .catch(function () {
        /* the table keeps its previous contents; the next poll retries */
      });
  }

  function poll() {
    if (!active) {
      return;
    }
    var url = endpoint + "?since=" + encodeURIComponent(String(version));
    fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (resp) {
        return resp.json().then(function (body) {
          if (!resp.ok) {
            throw new Error((body.error && body.error.message) || "HTTP " + resp.status);
          }
          return body;
        });
      })
      .then(function (body) {
        backoff = 1000;
        if (!active) {
          return;
        }
        if (body.version !== version) {
          version = body.version;
          badge.textContent = "版本 " + version;
          setStatus("收到变更：" + body.since + " -> " + body.version, "ok");
          render(body.changes || {});
          refreshDirectory(version);
          schedule(poll, 0);
          return;
        }
        setStatus("监听中…（等待版本 " + version + " 之后的变更）");
        schedule(poll, 0);
      })
      .catch(function (err) {
        if (!active) {
          return;
        }
        setStatus("监听中断：" + err.message + "，" + Math.round(backoff / 1000) + " 秒后重试", "bad");
        var wait = backoff;
        backoff = Math.min(backoff * 2, 15000);
        schedule(poll, wait);
      });
  }

  toggle.addEventListener("click", function () {
    active = !active;
    if (active) {
      toggle.textContent = "停止监听";
      log.textContent = "";
      setStatus("监听中…（等待版本 " + version + " 之后的变更）");
      poll();
    } else {
      toggle.textContent = "开启监听";
      setStatus("已停止监听，正在显示版本 " + version + "。");
    }
  });

  window.addEventListener("beforeunload", function () {
    active = false;
  });
})();
