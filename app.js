(function () {
  'use strict';

  var STORAGE_KEY = 'inventory.items.v1';
  var UNIT_TO_ML = { ml: 1, L: 1000, g: 1, kg: 1000, oz: 1 };

  var items = load();
  var sortKey = 'name';
  var sortDir = 1;
  var filterStatus = 'all';

  var $ = function (id) { return document.getElementById(id); };

  // ---------- Storage ----------

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      toast('Could not save on this device. Storage may be full or blocked.');
    }
    pushCloud();
  }

  // ---------- Shared list (Supabase) ----------
  // All products live in one row of the "inventory" table. Every save writes
  // the whole list, and the app reloads it every 20 seconds and on focus.

  var ROW_ID = 'main';
  var cloud = null;
  var pushTimer = null;

  if (window.supabase && window.INVENTORY_CONFIG && INVENTORY_CONFIG.url && INVENTORY_CONFIG.anonKey) {
    cloud = window.supabase.createClient(INVENTORY_CONFIG.url, INVENTORY_CONFIG.anonKey);
  }

  function setSyncStatus(text) {
    var el = $('sync-status');
    if (el) el.textContent = text;
  }

  function pullCloud() {
    // Don't overwrite local changes that haven't been pushed yet.
    if (!cloud || pushTimer) return;
    cloud.from('inventory').select('data').eq('id', ROW_ID).single().then(function (res) {
      if (res.error || !res.data) {
        setSyncStatus('Could not reach the shared list. Showing this device\'s copy.');
        return;
      }
      if (Array.isArray(res.data.data)) {
        items = res.data.data;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch (e) {}
        setSyncStatus('Shared list: up to date');
        refreshCurrentTab();
      }
    });
  }

  function pushCloud() {
    if (!cloud) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      cloud.from('inventory').upsert({ id: ROW_ID, data: items }).then(function (res) {
        setSyncStatus(res.error ? 'Could not save to the shared list. Check your connection.' : 'Shared list: up to date');
      });
    }, 300);
  }

  function refreshCurrentTab() {
    var active = document.querySelector('.tab.active');
    if (active && active.dataset.tab === 'inventory') renderInventory();
    else renderSearch();
  }

  // ---------- Helpers ----------

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function fmtVolume(item) {
    return item.volume + ' ' + item.unit;
  }

  function qtyCell(item) {
    return item.quantity > 0
      ? esc(item.quantity)
      : '<span class="badge out">Out of stock</span>';
  }

  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleDateString() : '-';
  }

  function volumeInMl(item) {
    return item.volume * (UNIT_TO_ML[item.unit] || 1);
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2800);
  }

  // ---------- Tabs ----------

  var tabButtons = document.querySelectorAll('.tab');

  function showTab(name) {
    tabButtons.forEach(function (b) {
      var active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.hidden = p.id !== 'panel-' + name;
    });
    if (name === 'search') renderSearch();
    if (name === 'inventory') renderInventory();
  }

  tabButtons.forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });

  // ---------- Search (available products only) ----------

  function availableMatches() {
    var name = $('search-name').value.trim().toLowerCase();
    var volumeRaw = $('search-volume').value.trim();
    var volume = volumeRaw === '' ? null : parseFloat(volumeRaw);

    return items.filter(function (it) {
      if (it.status !== 'available') return false;
      if (name && it.name.toLowerCase().indexOf(name) === -1) return false;
      if (volume !== null && !isNaN(volume) && it.volume !== volume) return false;
      return true;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function renderSearch() {
    var matches = availableMatches();
    var body = $('search-body');

    if (matches.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="empty">No available products match your search.</td></tr>';
    } else {
      body.innerHTML = matches.map(function (it) {
        return '<tr>' +
          '<td>' + esc(it.name) + '</td>' +
          '<td>' + esc(fmtVolume(it)) + '</td>' +
          '<td>' + qtyCell(it) + '</td>' +
          '<td class="actions"><button class="btn small success" type="button" data-take="' + esc(it.id) + '">Mark taken</button></td>' +
          '</tr>';
      }).join('');
    }

    var available = items.filter(function (it) { return it.status === 'available'; }).length;
    $('search-count').textContent = matches.length + ' of ' + available + ' available products shown';
  }

  $('search-body').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-take]');
    if (!btn) return;
    var item = findItem(btn.dataset.take);
    if (!item) return;
    // Out-of-stock products stay in the search results; they are only marked
    // taken from the Inventory tab.
    if (item.quantity < 1) {
      toast('"' + item.name + '" is out of stock. Use Add in the Inventory tab to restock.');
      return;
    }
    takeQuantity(item);
    renderSearch();
  });

  // Removes some units from stock. Taking the last units leaves the product
  // in Available as "Out of stock". A product with no stock is marked taken.
  function takeQuantity(item) {
    if (item.quantity < 1) {
      if (!confirm('"' + item.name + '" is out of stock. Mark it as taken?')) return false;
      item.status = 'taken';
      item.dateTaken = new Date().toISOString();
      save();
      toast('"' + item.name + '" was marked as taken.');
      return true;
    }

    var input = prompt('How many "' + item.name + '" (' + fmtVolume(item) + ') to take out? In stock: ' + item.quantity, '1');
    if (input === null) return false;

    var qty = parseInt(input, 10);
    if (!(qty >= 1) || qty > item.quantity || String(qty) !== input.trim()) {
      toast('Enter a whole number from 1 to ' + item.quantity + '.');
      return false;
    }

    // Record the units taken as their own Taken entry, so it shows in Inventory.
    var now = new Date().toISOString();
    item.quantity -= qty;
    items.push({
      id: uid(),
      sourceId: item.id,
      name: item.name,
      volume: item.volume,
      unit: item.unit,
      quantity: qty,
      notes: item.notes,
      status: 'taken',
      dateAdded: item.dateAdded,
      dateTaken: now
    });
    save();

    toast(item.quantity === 0
      ? '"' + item.name + '" is now out of stock.'
      : 'Took ' + qty + ' from "' + item.name + '". ' + item.quantity + ' left.');
    return true;
  }

  $('search-name').addEventListener('input', renderSearch);
  $('search-volume').addEventListener('input', renderSearch);

  $('search-clear').addEventListener('click', function () {
    $('search-name').value = '';
    $('search-volume').value = '';
    $('search-name').focus();
    renderSearch();
  });

  // ---------- Inventory (full list, sortable) ----------

  // Each product is exactly one of: taken, out of stock, or available.
  function stockState(item) {
    if (item.status === 'taken') return 'taken';
    return item.quantity > 0 ? 'available' : 'out';
  }

  var STATE_LABELS = { available: 'Available', out: 'Out of stock', taken: 'Taken' };

  function sortedInventory() {
    var list = items.filter(function (it) {
      return filterStatus === 'all' || stockState(it) === filterStatus;
    });

    var compare = {
      name: function (a, b) { return a.name.localeCompare(b.name); },
      volume: function (a, b) {
        var diff = volumeInMl(a) - volumeInMl(b);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      },
      date: function (a, b) {
        return (a.dateAdded || '').localeCompare(b.dateAdded || '');
      }
    }[sortKey];

    return list.sort(function (a, b) { return compare(a, b) * sortDir; });
  }

  function renderInventory() {
    var list = sortedInventory();
    var body = $('inventory-body');

    if (list.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No items yet. Use the Add Item tab to get started.</td></tr>';
    } else {
      body.innerHTML = list.map(function (it) {
        var state = stockState(it);
        var isTaken = state === 'taken';
        return '<tr>' +
          '<td>' + esc(it.name) + '</td>' +
          '<td>' + esc(fmtVolume(it)) + '</td>' +
          '<td>' + qtyCell(it) + '</td>' +
          '<td><span class="badge ' + state + '">' + STATE_LABELS[state] + '</span></td>' +
          '<td>' + esc(fmtDate(it.dateAdded)) + '</td>' +
          '<td class="actions">' +
            '<button class="btn small secondary" type="button" data-toggle="' + esc(it.id) + '">' + (isTaken ? 'Restore' : 'Mark taken') + '</button> ' +
            '<button class="btn small success" type="button" data-restock="' + esc(it.id) + '">Add</button> ' +
            '<button class="btn small danger" type="button" data-delete="' + esc(it.id) + '">Delete</button>' +
          '</td>' +
          '</tr>';
      }).join('');
    }

    document.querySelectorAll('.sort').forEach(function (btn) {
      var active = btn.dataset.sort === sortKey;
      btn.querySelector('span').textContent = active ? (sortDir === 1 ? '▲' : '▼') : '';
    });

    var text = list.length + ' item(s) shown';
    if (filterStatus === 'taken') {
      var unitsTaken = list.reduce(function (sum, it) { return sum + it.quantity; }, 0);
      text += ' · ' + unitsTaken + ' unit(s) taken';
    }
    $('inventory-count').textContent = text;
    updateFilterCounts();
  }

  // Shows how many products are in each group, e.g. "Taken (3)".
  function updateFilterCounts() {
    var counts = { all: items.length, available: 0, out: 0, taken: 0 };
    items.forEach(function (it) { counts[stockState(it)]++; });

    var labels = { all: 'All items', available: 'Available', out: 'Out of stock', taken: 'Taken' };
    document.querySelectorAll('#filter-status option').forEach(function (opt) {
      opt.textContent = labels[opt.value] + ' (' + counts[opt.value] + ')';
    });
  }

  document.querySelectorAll('.sort').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.dataset.sort;
      if (sortKey === key) {
        sortDir = -sortDir;
      } else {
        sortKey = key;
        sortDir = 1;
      }
      renderInventory();
    });
  });

  $('filter-status').addEventListener('change', function (e) {
    filterStatus = e.target.value;
    renderInventory();
  });

  $('inventory-body').addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-toggle]');
    var restock = e.target.closest('[data-restock]');
    var del = e.target.closest('[data-delete]');

    if (toggle) {
      var item = findItem(toggle.dataset.toggle);
      if (!item) return;
      if (item.status === 'taken') {
        restoreItem(item);
        renderInventory();
      } else if (takeQuantity(item)) {
        renderInventory();
      }
    }

    if (restock) {
      var stockItem = findItem(restock.dataset.restock);
      if (stockItem) addStock(stockItem);
    }

    if (del) {
      var target = findItem(del.dataset.delete);
      if (!target) return;
      if (!confirm('Delete "' + target.name + '"? This cannot be undone.')) return;
      items = items.filter(function (it) { return it.id !== target.id; });
      save();
      renderInventory();
      toast('Item deleted.');
    }
  });

  // Puts a Taken entry back into stock. If its original product still exists,
  // the units go back onto that product and the Taken entry is removed.
  function restoreItem(item) {
    var source = item.sourceId ? findItem(item.sourceId) : null;
    if (source && source.status === 'available') {
      source.quantity += item.quantity;
      items = items.filter(function (it) { return it !== item; });
    } else {
      item.status = 'available';
      item.dateTaken = null;
    }
    save();
    toast('"' + item.name + '" was restored to stock.');
  }

  // Adds units to an existing product's stock (for example, a new delivery).
  function addStock(item) {
    var input = prompt('How many "' + item.name + '" (' + fmtVolume(item) + ') to add? Current stock: ' + item.quantity, '1');
    if (input === null) return;

    var qty = parseInt(input, 10);
    if (!(qty >= 1) || String(qty) !== input.trim()) {
      toast('Enter a whole number of 1 or more.');
      return;
    }

    item.quantity += qty;
    item.status = 'available';
    save();
    renderInventory();
    toast('Added ' + qty + ' to "' + item.name + '". Stock is now ' + item.quantity + '.');
  }

  function findItem(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  // ---------- CSV export ----------

  $('export-csv').addEventListener('click', function () {
    if (items.length === 0) {
      toast('There is nothing to export yet.');
      return;
    }
    var header = ['Name', 'Volume', 'Unit', 'Quantity', 'Status', 'Date added', 'Date taken', 'Notes'];
    var rows = items.map(function (it) {
      return [it.name, it.volume, it.unit, it.quantity, it.status, it.dateAdded, it.dateTaken || '', it.notes || '']
        .map(function (cell) { return '"' + String(cell).replace(/"/g, '""') + '"'; })
        .join(',');
    });
    var csv = '﻿' + [header.join(',')].concat(rows).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'inventory-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  // ---------- Add item ----------

  var addForm = $('add-form');

  function setError(field, message) {
    var el = addForm.querySelector('[data-for="' + field + '"]');
    if (el) el.textContent = message || '';
  }

  function validate(data) {
    var ok = true;
    setError('name', '');
    setError('volume', '');
    setError('quantity', '');

    if (!data.name) { setError('name', 'Enter a product name.'); ok = false; }
    if (!(data.volume > 0)) { setError('volume', 'Enter a volume greater than 0.'); ok = false; }
    if (isNaN(data.quantity) || data.quantity < 0 || Math.floor(data.quantity) !== data.quantity) {
      setError('quantity', 'Quantity must be a whole number, 0 or more.');
      ok = false;
    }
    return ok;
  }

  function isDuplicate(data) {
    return items.some(function (it) {
      return it.status === 'available' &&
        it.name.toLowerCase() === data.name.toLowerCase() &&
        it.volume === data.volume &&
        it.unit === data.unit;
    });
  }

  addForm.addEventListener('submit', function (e) {
    e.preventDefault();

    var data = {
      name: $('add-name').value.trim(),
      volume: parseFloat($('add-volume').value),
      unit: $('add-unit').value,
      quantity: parseInt($('add-quantity').value, 10),
      notes: $('add-notes').value.trim()
    };

    if (!validate(data)) return;

    if (isDuplicate(data) && !confirm('An available item with the same name and volume already exists. Add it anyway?')) {
      return;
    }

    items.push({
      id: uid(),
      name: data.name,
      volume: data.volume,
      unit: data.unit,
      quantity: data.quantity,
      notes: data.notes,
      status: 'available',
      dateAdded: new Date().toISOString(),
      dateTaken: null
    });
    save();

    addForm.reset();
    $('add-quantity').value = '1';
    addForm.hidden = true;
    renderInventory();
    toast('"' + data.name + '" was added to inventory.');
  });

  $('show-add').addEventListener('click', function () {
    addForm.hidden = false;
    $('add-name').focus();
    addForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('add-cancel').addEventListener('click', function () {
    addForm.reset();
    $('add-quantity').value = '1';
    setError('name', '');
    setError('volume', '');
    setError('quantity', '');
    addForm.hidden = true;
  });

  // ---------- Start ----------

  showTab('search');

  if (cloud) {
    pullCloud();
    setInterval(pullCloud, 20000);
    window.addEventListener('focus', pullCloud);
  } else {
    setSyncStatus('This device only. Add your Supabase keys in config.js to share the list.');
  }

  // Offline support. Only works when the app is served over http(s),
  // not when index.html is opened directly from a file.
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
