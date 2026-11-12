/* ════════════════════════════════════════════════════════════════════════════
   RFFS BOD — Fonctionnement hors connexion
   Ce fichier garde une copie du site sur l'appareil, pour qu'il s'ouvre sans réseau.
   - Avec du réseau : la page vient toujours du site (dernière version), et la copie est mise à jour.
   - Sans réseau : la page vient de la copie gardée sur l'appareil.
   À chaque mise à jour du site, augmenter NUMERO (le même que « ?v= » dans les pages).
   ════════════════════════════════════════════════════════════════════════════ */
const NUMERO = '5';
const CACHE  = 'rffs-bod-' + NUMERO;
const DELAI_MS = 4000;   // au-delà, on sert la copie de l'appareil

const FICHIERS = [
  './', 'index.html', 'generateur_rffs.html', 'generateur_incendie.html', 'evaluation_rffs.html', 'historique.html',
  'fiches.json', 'rffs-cloud.js', 'rffs-schema.js', 'manifest.webmanifest',
  'lib/firebase-app-compat.js', 'lib/firebase-auth-compat.js', 'lib/firebase-firestore-compat.js',
  'icons/icon-192.png', 'icons/icon-512.png'
];

// Installation : copie de tous les fichiers du site sur l'appareil.
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(FICHIERS.map(function (u) { return new Request(u, { cache: 'reload' }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

// Activation : suppression des copies des versions précédentes.
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (noms) {
        return Promise.all(noms.filter(function (n) { return n.indexOf('rffs-bod-') === 0 && n !== CACHE; })
                               .map(function (n) { return caches.delete(n); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function cle(url) { return url.origin + url.pathname; }           // sans le « ?v=… »

function depuisCopie(url, navigation) {
  return caches.open(CACHE).then(function (c) {
    return c.match(cle(url), { ignoreSearch: true }).then(function (r) {
      if (r) return r;
      if (navigation) return c.match(new URL('index.html', self.registration.scope).href);
      return undefined;
    });
  });
}

function reseauDAbord(req, url) {
  var navigation = req.mode === 'navigate';
  var reseau = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(function (rep) {
    if (rep && rep.ok) {
      var copie = rep.clone();
      caches.open(CACHE).then(function (c) { c.put(cle(url), copie); });
    }
    return rep;
  });
  var limite = new Promise(function (ok) { setTimeout(ok, DELAI_MS); }).then(function () { return depuisCopie(url, navigation); });
  return Promise.race([
    reseau.catch(function () { return depuisCopie(url, navigation); }),
    limite.then(function (r) { return r || reseau; })
  ]).then(function (r) { return r || reseau; })
    .catch(function () { return depuisCopie(url, navigation).then(function (r) { return r || Response.error(); }); });
}

function copieDAbord(req, url) {
  return depuisCopie(url, false).then(function (r) {
    return r || fetch(req).then(function (rep) {
      if (rep && rep.ok) { var copie = rep.clone(); caches.open(CACHE).then(function (c) { c.put(cle(url), copie); }); }
      return rep;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                               // Firebase, polices… : non concernés
  if (url.href.indexOf(self.registration.scope) !== 0) return;
  var fige = url.pathname.indexOf('/lib/') >= 0 || url.pathname.indexOf('/icons/') >= 0;   // fichiers qui ne changent pas
  e.respondWith(fige ? copieDAbord(req, url) : reseauDAbord(req, url));
});
