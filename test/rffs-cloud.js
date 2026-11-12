/* ════════════════════════════════════════════════════════════════════════════
   RFFS BOD — Fichier commun "cloud" (Firebase)
   Chargé par les 5 pages. Gère : la connexion (Formateur / Chef de service),
   l'envoi et la lecture des fiches, le bandeau d'accueil, la liste des agents.
   ════════════════════════════════════════════════════════════════════════════ */

/* ── 1. CONFIGURATION DU PROJET FIREBASE « rffs-bod » ─────────────────────── */

// Bloc fourni par Firebase (Paramètres du projet > Vos applications).
var RFFS_FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBJWgn-6j1M-icZEjtFzVXlLnOhKbJtSxI",
  authDomain:        "rffs-bod.firebaseapp.com",
  projectId:         "rffs-bod",
  storageBucket:     "rffs-bod.firebasestorage.app",
  messagingSenderId: "344792683618",
  appId:             "1:344792683618:web:c742da557090bb3c07ad3b"
};

// Adresses des deux comptes créés dans Firebase > Authentication.
// Ce sont des identifiants, pas des secrets : le secret, c'est le mot de passe.
var RFFS_COMPTES = {
  formateur: "formateur@rffs-bod.firebaseapp.com",
  chef:      "chef@rffs-bod.firebaseapp.com"
};

/* ── 2. LISTE DES AGENTS (remplie après connexion, plus jamais dans le code) ── */
var AGENTS = {};

/* ── 3. MOTEUR ─────────────────────────────────────────────────────────────── */
var RFFS = (function () {
  'use strict';

  var VERSION = '12/11/2026 – 5';
  var CLE_AGENTS = 'rffs_agents_cache';
  var LIBELLES   = { formateur: 'Formateur', chef: 'Chef de service' };
  var DELAI_MS   = 5000;          // au-delà, on considère qu'il n'y a pas de réseau
  var TAILLE_MAX = 900000;        // limite Firebase : 1 Mo par fiche

  var configure = RFFS_FIREBASE_CONFIG.apiKey !== 'A_REMPLIR' &&
                  RFFS_COMPTES.formateur !== 'A_REMPLIR' &&
                  typeof firebase !== 'undefined';
  var auth = null, db = null;
  var role = null;                // null | 'formateur' | 'chef'
  var pret = false;               // true quand Firebase a dit qui est connecté
  var ecouteurs = [];
  var apresConnexion = null;      // action à lancer après une connexion réussie

  /* ── utilitaires ── */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Nettoie un bloc HTML enregistré (fiche, schéma) avant de l'afficher : retire tout code exécutable.
  function safeHtml(html) {
    if (!html) return '';
    try {
      var doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
      var racine = doc.getElementById('r');
      racine.querySelectorAll('script,iframe,object,embed,link,meta,base,form').forEach(function (n) { n.remove(); });
      racine.querySelectorAll('*').forEach(function (n) {
        Array.prototype.slice.call(n.attributes).forEach(function (a) {
          var nom = a.name.toLowerCase(), val = String(a.value).replace(/\s+/g, '').toLowerCase();
          if (nom.indexOf('on') === 0) n.removeAttribute(a.name);
          else if ((nom === 'href' || nom === 'src' || nom === 'xlink:href' || nom === 'action') && val.indexOf('javascript:') === 0) n.removeAttribute(a.name);
        });
      });
      return racine.innerHTML;
    } catch (e) { return ''; }
  }
  function poids(txt) {
    try { return new Blob([txt || '']).size; } catch (e) { return (txt || '').length * 2; }
  }
  function avecDelai(promesse, valeurSiLent) {
    return Promise.race([
      promesse,
      new Promise(function (ok) { setTimeout(function () { ok(valeurSiLent); }, DELAI_MS); })
    ]);
  }
  function remplirAgents(equipes) {
    Object.keys(AGENTS).forEach(function (k) { delete AGENTS[k]; });
    Object.keys(equipes || {})
      .sort(function (a, b) { return a.localeCompare(b, 'fr', { numeric: true }); })
      .forEach(function (k) {
        if (Array.isArray(equipes[k])) AGENTS[k] = equipes[k].map(String);
      });
  }
  // Prévient les pages uniquement quand le profil connecté change.
  function prevenir() {
    majBadge();
    ecouteurs.forEach(function (f) { try { f(role); } catch (e) { console.warn(e); } });
  }

  /* ── démarrage ── */
  try { remplirAgents(JSON.parse(localStorage.getItem(CLE_AGENTS) || '{}')); } catch (e) {}

  if (configure) {
    try {
      firebase.initializeApp(RFFS_FIREBASE_CONFIG);
      auth = firebase.auth();
      db   = firebase.firestore();
      // Mode hors connexion : les fiches attendent sur l'appareil et partent au retour du réseau.
      db.enablePersistence({ synchronizeTabs: true }).catch(function () {});
      auth.onAuthStateChanged(function (user) {
        var mail = user && user.email ? user.email.toLowerCase() : '';
        if (mail && mail === RFFS_COMPTES.chef.toLowerCase())           role = 'chef';
        else if (mail && mail === RFFS_COMPTES.formateur.toLowerCase()) role = 'formateur';
        else role = null;
        pret = true;
        if (role) chargerAgents(); else viderAgents();
        prevenir();
      });
    } catch (e) {
      console.warn('RFFS cloud : démarrage impossible', e);
      configure = false; pret = true;
    }
  } else {
    pret = true;
  }

  /* ── agents ── */
  function viderAgents() {
    remplirAgents({});
    try { localStorage.removeItem(CLE_AGENTS); } catch (e) {}
  }
  function chargerAgents() {
    if (!db) return Promise.resolve();
    return db.doc('config/agents').get().then(function (snap) {
      var equipes = snap.exists ? (snap.data().equipes || {}) : {};
      remplirAgents(equipes);
      try { localStorage.setItem(CLE_AGENTS, JSON.stringify(AGENTS)); } catch (e) {}
    }).catch(function (e) { console.warn('RFFS cloud : agents non chargés', e && e.code); });
  }
  function saveAgents(equipes) {
    if (role !== 'chef') return Promise.resolve(false);
    return avecDelai(
      db.doc('config/agents').set({
        equipes: equipes,
        majLe: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () { return true; }),
      'attente'
    ).then(function (r) {
      remplirAgents(equipes);
      try { localStorage.setItem(CLE_AGENTS, JSON.stringify(AGENTS)); } catch (e) {}
      return r;
    }).catch(function (e) { console.warn(e); return false; });
  }

  /* ── fiches ── */
  var CLES_FICHES = ['rffs_formatives', 'rffs_incendie_fiches'];

  function lire(cle) {
    try { return JSON.parse(localStorage.getItem(cle) || '[]'); } catch (e) { return []; }
  }
  // Écrit une liste de fiches sur l'appareil. Si la mémoire est pleine, allège les plus
  // anciennes (on retire leur schéma, on garde leurs informations) jusqu'à ce que ça passe.
  function stocker(cle, liste) {
    for (var essai = 0; essai < 500; essai++) {
      try { localStorage.setItem(cle, JSON.stringify(liste)); return true; }
      catch (e) {
        var lourde = null;
        liste.forEach(function (f) {
          if ((f.ficheFormHtml || f.schemaHtml) && (!lourde || Number(f.id) < Number(lourde.id))) lourde = f;
        });
        if (!lourde) break;
        delete lourde.ficheFormHtml; delete lourde.schemaHtml;
      }
    }
    toast('Mémoire de l\'appareil pleine : la fiche n\'a pas pu être gardée ici.', 'err');
    return false;
  }
  function marquer(id, etat) {
    CLES_FICHES.forEach(function (cle) {
      var liste = lire(cle), change = false;
      liste.forEach(function (f) { if (String(f.id) === String(id) && f.cloud !== etat) { f.cloud = etat; change = true; } });
      if (change) stocker(cle, liste);
    });
  }
  function versDoc(fiche) {
    var incendie = fiche.lieu !== undefined && fiche.aeronef === undefined;   // fiche du générateur incendie
    var doc = {
      id:           String(fiche.id),
      date:         fiche.date         || '',
      heure:        fiche.heure        || '',
      aeronef:      (incendie ? fiche.lieu : fiche.aeronef) || '',
      theme:        fiche.theme        || '',
      niveau:       Number(fiche.niveau) || 0,
      conditions:   (incendie ? fiche.vehType : fiche.conditions) || '',
      agents:       String(fiche.agents || ''),
      resultat:     fiche.resultat     || '',
      observations: fiche.observations || '',
      source:       incendie ? 'Incendie' : (fiche.source || 'Web'),
      profil:       role,
      creeLe:       firebase.firestore.FieldValue.serverTimestamp()
    };
    // La fiche complète (avec schéma) est jointe si elle tient dans la limite de 1 Mo.
    if (fiche.ficheFormHtml && poids(fiche.ficheFormHtml) < TAILLE_MAX) doc.ficheFormHtml = fiche.ficheFormHtml;
    else if (fiche.schemaHtml && poids(fiche.schemaHtml) < TAILLE_MAX)  doc.schemaHtml    = fiche.schemaHtml;
    return doc;
  }

  // Envoie une fiche déjà enregistrée sur l'appareil.
  // Renvoie : 'envoyee' | 'attente' (pas de réseau) | 'locale' (non connecté) | 'erreur'
  function saveFiche(fiche, silencieux) {
    function dire(m, t) { if (!silencieux) toast(m, t); }
    // La fiche est sur l'appareil : le brouillon automatique n'a plus lieu d'être.
    if (!silencieux) { try { document.dispatchEvent(new CustomEvent('rffs:fiche-enregistree')); } catch (e) {} }
    if (!configure || !role) {
      dire('Fiche enregistrée sur cet appareil uniquement — connecte-toi pour la partager.', 'info');
      return Promise.resolve('locale');
    }
    var doc = versDoc(fiche);
    return avecDelai(
      db.collection('fiches').doc(doc.id).set(doc).then(function () { return 'envoyee'; }),
      'attente'
    ).then(function (etat) {
      if (etat === 'envoyee') { marquer(doc.id, 'ok'); dire('Fiche enregistrée et envoyée ✓', 'ok'); }
      else dire('Pas de réseau : la fiche est gardée sur l\'appareil et partira au retour du réseau.', 'info');
      return etat;
    }).catch(function (e) {
      console.warn('RFFS cloud : envoi refusé', e && e.code);
      dire('La fiche est sur cet appareil, mais l\'envoi a été refusé. Reconnecte-toi puis clique sur Sync.', 'err');
      return 'erreur';
    });
  }

  // Renvoie { liste, horsLigne } ou null si la lecture est impossible.
  function getFiches() {
    if (!configure || !role) return Promise.resolve(null);
    return db.collection('fiches').get().then(function (snap) {
      var liste = [];
      snap.forEach(function (d) {
        var f = d.data();
        f.id = String(d.id).replace(/[^\w.-]/g, '');
        delete f.creeLe; delete f.profil;
        if (d.metadata && d.metadata.hasPendingWrites) f._attente = true;   // pas encore reçue par le serveur
        liste.push(f);
      });
      return { liste: liste, horsLigne: !!(snap.metadata && snap.metadata.fromCache) };
    }).catch(function (e) { console.warn('RFFS cloud : lecture impossible', e && e.code); return null; });
  }

  // Met l'appareil et le cloud d'accord. Renvoie { total, cloud, locales, horsLigne } ou null.
  //  - les fiches restées sur l'appareil (cloud:'non') sont envoyées ;
  //  - les fiches supprimées par le chef disparaissent de l'appareil ;
  //  - les fiches d'avant Firebase (sans marque) restent sur l'appareil, sans être envoyées.
  var synchroEnCours = null;
  function synchroniser() {
    if (synchroEnCours) return synchroEnCours;          // jamais deux synchros en même temps
    synchroEnCours = synchroniserUneFois().then(
      function (r) { synchroEnCours = null; return r; },
      function (e) { synchroEnCours = null; console.warn(e); return null; }
    );
    return synchroEnCours;
  }
  function synchroniserUneFois() {
    var debut = Date.now();
    return getFiches().then(function (res) {
      if (!res) return null;
      var confirmees = {}, distantes = {};
      res.liste.forEach(function (f) { distantes[f.id] = f; if (!f._attente) confirmees[f.id] = true; });

      // 1. envoyer ce qui attend sur l'appareil
      var aEnvoyer = [];
      CLES_FICHES.forEach(function (cle) {
        lire(cle).forEach(function (f) {
          if (f.cloud !== 'non') return;
          if (confirmees[String(f.id)]) marquer(f.id, 'ok');
          else if (!distantes[String(f.id)]) aEnvoyer.push(f);
        });
      });
      var chaine = Promise.resolve();
      aEnvoyer.forEach(function (f) {
        chaine = chaine.then(function () { return saveFiche(f, true); }).then(function (etat) {
          if (etat === 'envoyee') {
            var d = versDoc(f); delete d.creeLe; delete d.profil;
            distantes[d.id] = d; confirmees[d.id] = true;
          }
        });
      });

      // 2. fusionner dans l'historique de l'appareil
      return chaine.then(function () {
        var locales = lire('rffs_formatives'), gardees = [], vues = {};
        locales.forEach(function (f) {
          var id = String(f.id);
          if (distantes[id]) {
            // on garde le schéma de l'appareil si le cloud ne l'a pas
            if (!distantes[id].ficheFormHtml && f.ficheFormHtml) distantes[id].ficheFormHtml = f.ficheFormHtml;
            if (!distantes[id].schemaHtml && f.schemaHtml) distantes[id].schemaHtml = f.schemaHtml;
            return;
          }
          // Absente du cloud alors qu'elle y avait été envoyée : le chef l'a supprimée.
          // (On ne touche pas aux fiches enregistrées dans les 2 dernières minutes.)
          if (f.cloud === 'ok' && !res.horsLigne && Number(f.id) < debut - 120000) return;
          gardees.push(f);
        });
        var fusion = [];
        Object.keys(distantes).forEach(function (id) {
          var f = distantes[id];
          f.cloud = confirmees[id] ? 'ok' : 'non';
          delete f._attente;
          fusion.push(f); vues[id] = true;
        });
        fusion = fusion.concat(gardees);
        fusion.sort(function (a, b) {
          var da = (a.date || '').split('/').reverse().join('-'), dbb = (b.date || '').split('/').reverse().join('-');
          return da.localeCompare(dbb) || (Number(a.id) - Number(b.id));
        });
        stocker('rffs_formatives', fusion);
        return { total: fusion.length, cloud: Object.keys(distantes).length, locales: gardees.length, horsLigne: res.horsLigne };
      });
    });
  }

  // Réservé au chef. Renvoie true | 'attente' | false.
  function deleteFiche(id) {
    if (!configure || role !== 'chef') return Promise.resolve(false);
    return avecDelai(
      db.collection('fiches').doc(String(id)).delete().then(function () { return true; }),
      'attente'
    ).catch(function (e) { console.warn('RFFS cloud : suppression refusée', e && e.code); return false; });
  }

  /* ── bandeau d'accueil (lecture publique, écriture réservée au chef) ── */
  function getBandeau() {
    if (!configure) return Promise.resolve(null);
    return db.doc('config/bandeau').get().then(function (snap) {
      return snap.exists && snap.data().texte ? String(snap.data().texte) : null;
    }).catch(function () { return null; });
  }
  function setBandeau(texte) {
    if (!configure || role !== 'chef') return Promise.resolve(false);
    return avecDelai(
      db.doc('config/bandeau').set({
        texte: String(texte).slice(0, 100),
        majLe: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () { return true; }),
      'attente'
    ).catch(function (e) { console.warn(e); return false; });
  }

  /* ── connexion ── */
  function messageErreur(e) {
    var c = (e && e.code) || '';
    if (c.indexOf('network') >= 0)  return 'Pas de réseau : connexion impossible pour le moment.';
    if (c.indexOf('too-many') >= 0) return 'Trop d\'essais. Réessaie dans quelques minutes.';
    if (c.indexOf('user-disabled') >= 0) return 'Ce profil a été désactivé.';
    return 'Mot de passe incorrect.';
  }
  function connecter(profil, motDePasse) {
    if (!configure) return Promise.reject({ code: 'non-configure' });
    var P = firebase.auth.Auth.Persistence;
    // Formateur : la tablette reste connectée. Chef : déconnexion à la fermeture de l'onglet.
    return auth.setPersistence(profil === 'chef' ? P.SESSION : P.LOCAL)
      .catch(function () {})
      .then(function () { return auth.signInWithEmailAndPassword(RFFS_COMPTES[profil], motDePasse); });
  }
  function logout() {
    if (!auth) return Promise.resolve();
    return auth.signOut();
  }
  // Lance "action" si le profil demandé est actif ; sinon ouvre la connexion puis lance l'action.
  function requireRole(profil, action) {
    if (role === profil || (profil === 'formateur' && role === 'chef')) { action(); return; }
    if (!configure) { toast('Le cloud n\'est pas encore configuré sur ce site.', 'err'); return; }
    ouvrirConnexion(profil, action);
  }

  /* ── interface : badge, fenêtre de connexion, messages ── */
  var CSS = '' +
    '#rffs-badge{position:fixed;right:12px;bottom:12px;z-index:9000;min-height:44px;padding:0 16px;border-radius:22px;border:2px solid #fff;' +
      'background:#002F5F;color:#fff;font:600 13px/1 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.3);display:flex;align-items:center;gap:6px;}' +
    '#rffs-badge.off{background:#6b7280;}#rffs-badge.chef{background:#E8500A;}' +
    '#rffs-voile{position:fixed;inset:0;z-index:9500;background:rgba(0,20,45,.6);display:none;align-items:center;justify-content:center;padding:16px;}' +
    '#rffs-voile.open{display:flex;}' +
    '#rffs-boite{background:#fff;border-radius:14px;width:100%;max-width:360px;padding:22px;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#1a2433;box-shadow:0 12px 40px rgba(0,0,0,.35);}' +
    '#rffs-boite h3{margin:0 0 4px;font-size:18px;color:#002F5F;}#rffs-boite p{margin:0 0 14px;font-size:13px;color:#5b6676;}' +
    '.rffs-profils{display:flex;gap:8px;margin-bottom:12px;}' +
    '.rffs-profils button{flex:1;min-height:48px;border-radius:9px;border:2px solid #d5dbe3;background:#fff;font:600 14px system-ui,sans-serif;color:#002F5F;cursor:pointer;}' +
    '.rffs-profils button.actif{border-color:#002F5F;background:#002F5F;color:#fff;}' +
    '.rffs-profils button:disabled{opacity:.35;cursor:default;}' +
    '#rffs-mdp{width:100%;box-sizing:border-box;min-height:48px;padding:0 12px;border:2px solid #d5dbe3;border-radius:9px;font-size:16px;margin-bottom:8px;}' +
    '#rffs-mdp:focus{outline:none;border-color:#E8500A;}' +
    '#rffs-err{min-height:18px;font-size:13px;color:#c00000;margin-bottom:8px;}' +
    '.rffs-btn{width:100%;min-height:48px;border:none;border-radius:9px;font:700 15px system-ui,sans-serif;cursor:pointer;margin-top:6px;}' +
    '.rffs-btn.p{background:#E8500A;color:#fff;}.rffs-btn.s{background:#eef1f5;color:#002F5F;}.rffs-btn:disabled{opacity:.6;}' +
    '#rffs-toast{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);z-index:9600;max-width:min(92vw,460px);padding:12px 16px;border-radius:10px;' +
      'font:600 14px/1.35 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#fff;background:#002F5F;box-shadow:0 6px 20px rgba(0,0,0,.3);display:none;text-align:center;}' +
    '#rffs-toast.ok{background:#2e7d32;}#rffs-toast.err{background:#c00000;}#rffs-toast.info{background:#002F5F;}' +
    '@media print{#rffs-badge,#rffs-voile,#rffs-toast{display:none!important;}}';

  // Confort d'usage au doigt (tablette, téléphone) et petits écrans. N'agit pas sur l'impression.
  var CSS_TACTILE = '' +
    '.app-body>*{min-width:0;}' +
    '@media screen and (max-width:820px){.app-body>main{overflow-x:auto;-webkit-overflow-scrolling:touch;}}' +
    '@media screen and (max-width:600px){' +
      'body>header{height:auto;min-height:64px;flex-wrap:wrap;padding:8px 12px;row-gap:4px;}' +
      'body>header nav{flex-wrap:wrap;gap:2px;}body>header nav a{padding:8px 9px;font-size:13px;}' +
    '}' +
    '@media screen and (pointer:coarse){' +
      'button,select,textarea,input[type=text],input[type=number],input[type=password],input[type=email],' +
      '.btn,a.btn-home,.back-link,.m-tab,.manual-toggle,.vbadge,body>header nav a,.app-bar a,a[href$=".html"]{min-height:44px;}' +
      'a.btn-home,.back-link,.m-tab,.manual-toggle,.vbadge,body>header nav a,.app-bar a,a[href$=".html"]{display:inline-flex;align-items:center;align-content:center;}' +
      'select,textarea,input[type=text],input[type=number],input[type=password],input[type=email]{font-size:16px;}' +
      'input[type=checkbox],input[type=radio]{width:22px;height:22px;min-height:0;flex-shrink:0;}' +
      'label:has(>input[type=checkbox]),label:has(>input[type=radio]){min-height:44px;display:inline-flex;align-items:center;gap:8px;}' +
    '}';

  var elBadge, elVoile, elToast, profilChoisi = 'formateur', profilImpose = null, minuterieToast;

  function monter() {
    if (document.getElementById('rffs-badge')) return;
    var st = document.createElement('style'); st.textContent = CSS + CSS_TACTILE; document.head.appendChild(st);

    elBadge = document.createElement('button');
    elBadge.id = 'rffs-badge'; elBadge.type = 'button';
    elBadge.addEventListener('click', clicBadge);
    document.body.appendChild(elBadge);

    elVoile = document.createElement('div');
    elVoile.id = 'rffs-voile';
    elVoile.addEventListener('click', function (e) { if (e.target === elVoile) fermer(); });
    document.body.appendChild(elVoile);

    elToast = document.createElement('div');
    elToast.id = 'rffs-toast'; elToast.setAttribute('role', 'status');
    document.body.appendChild(elToast);

    majBadge();
  }

  function majBadge() {
    if (!elBadge) return;
    elBadge.className = '';
    if (!configure)      { elBadge.textContent = '☁ Cloud non configuré'; elBadge.className = 'off'; }
    else if (!pret)      { elBadge.textContent = '☁ …'; elBadge.className = 'off'; }
    else if (!role)      { elBadge.textContent = '🔒 Se connecter'; elBadge.className = 'off'; }
    else if (role === 'chef') { elBadge.textContent = '👨‍✈️ Chef de service'; elBadge.className = 'chef'; }
    else                 { elBadge.textContent = '👤 Formateur'; }
    if (navigator.onLine === false) elBadge.textContent += ' · hors ligne';
  }
  window.addEventListener('online',  function () { majBadge(); });
  window.addEventListener('offline', function () { majBadge(); });

  // Fonctionnement hors connexion : sw.js garde une copie du site sur l'appareil.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('RFFS : mode hors connexion indisponible', e); });
    });
  }

  function clicBadge() {
    if (!configure) { toast('Le cloud n\'est pas encore configuré : les fiches restent sur cet appareil.', 'info'); return; }
    if (role) ouvrirCompte(); else ouvrirConnexion(null, null);
  }

  function fermer() { elVoile.classList.remove('open'); elVoile.innerHTML = ''; apresConnexion = null; }

  function ouvrirCompte() {
    elVoile.innerHTML =
      '<div id="rffs-boite" role="dialog" aria-modal="true" aria-label="Profil connecté">' +
        '<h3>' + esc(LIBELLES[role]) + '</h3>' +
        '<p>Tu es connecté avec ce profil sur cet appareil.<br><span style="font-size:11px;">Version du site : ' + esc(VERSION) + '</span></p>' +
        '<button type="button" class="rffs-btn p" id="rffs-changer">Changer de profil</button>' +
        '<button type="button" class="rffs-btn s" id="rffs-deco">Se déconnecter</button>' +
        '<button type="button" class="rffs-btn s" id="rffs-fermer">Fermer</button>' +
      '</div>';
    elVoile.classList.add('open');
    document.getElementById('rffs-fermer').onclick = fermer;
    document.getElementById('rffs-deco').onclick = function () { logout().then(fermer); };
    document.getElementById('rffs-changer').onclick = function () { ouvrirConnexion(null, null); };
  }

  function ouvrirConnexion(profil, action) {
    profilImpose = profil || null;
    profilChoisi = profil || (role === 'formateur' ? 'chef' : 'formateur');
    elVoile.innerHTML =
      '<div id="rffs-boite" role="dialog" aria-modal="true" aria-label="Connexion">' +
        '<h3>Connexion</h3>' +
        '<p>' + (profilImpose === 'chef' ? 'Cette action est réservée au chef de service.' : 'Choisis ton profil et saisis le mot de passe.') + '</p>' +
        '<div class="rffs-profils">' +
          '<button type="button" data-p="formateur">👤 Formateur</button>' +
          '<button type="button" data-p="chef">👨‍✈️ Chef de service</button>' +
        '</div>' +
        '<label for="rffs-mdp" style="font-size:12px;font-weight:600;color:#5b6676;display:block;margin-bottom:4px;">Mot de passe</label>' +
        '<input id="rffs-mdp" type="password" autocomplete="current-password">' +
        '<div id="rffs-err" role="alert"></div>' +
        '<button type="button" class="rffs-btn p" id="rffs-ok">Se connecter</button>' +
        '<button type="button" class="rffs-btn s" id="rffs-annuler">Annuler</button>' +
      '</div>';
    elVoile.classList.add('open');
    apresConnexion = action || null;       // après fermer() éventuel, qui remet à zéro

    var boutons = elVoile.querySelectorAll('.rffs-profils button');
    function peindre() {
      boutons.forEach(function (b) {
        b.classList.toggle('actif', b.getAttribute('data-p') === profilChoisi);
        b.disabled = !!profilImpose && b.getAttribute('data-p') !== profilImpose;
      });
    }
    boutons.forEach(function (b) {
      b.onclick = function () { profilChoisi = b.getAttribute('data-p'); peindre(); champ.focus(); };
    });
    var champ = document.getElementById('rffs-mdp'), err = document.getElementById('rffs-err'), ok = document.getElementById('rffs-ok');
    peindre();
    champ.focus();

    function valider() {
      if (!champ.value) { err.textContent = 'Saisis le mot de passe.'; return; }
      ok.disabled = true; ok.textContent = 'Connexion…'; err.textContent = '';
      var suite = apresConnexion;
      connecter(profilChoisi, champ.value).then(function () {
        fermer();
        toast('Connecté : ' + LIBELLES[profilChoisi], 'ok');
        // on laisse à Firebase le temps d'annoncer le nouveau profil avant de lancer l'action
        if (suite) attendreRole(profilChoisi, suite);
      }).catch(function (e) {
        ok.disabled = false; ok.textContent = 'Se connecter';
        err.textContent = messageErreur(e);
        champ.value = ''; champ.focus();
      });
    }
    ok.onclick = valider;
    champ.onkeydown = function (e) { if (e.key === 'Enter') valider(); };
    document.getElementById('rffs-annuler').onclick = fermer;
  }

  // Demande de confirmation affichée dans la page (les fenêtres du navigateur peuvent être bloquées).
  // Renvoie une promesse : true si l'utilisateur confirme, false sinon.
  function confirmer(message, libelle) {
    return new Promise(function (resoudre) {
      if (!elVoile) { resoudre(window.confirm(message)); return; }
      elVoile.innerHTML =
        '<div id="rffs-boite" role="alertdialog" aria-modal="true" aria-label="Confirmation">' +
          '<h3>Confirmation</h3>' +
          '<p style="font-size:14px;color:#1a2433;">' + esc(message) + '</p>' +
          '<button type="button" class="rffs-btn p" id="rffs-conf-oui" style="background:#c00000;">' + esc(libelle || 'Confirmer') + '</button>' +
          '<button type="button" class="rffs-btn s" id="rffs-conf-non">Annuler</button>' +
        '</div>';
      elVoile.classList.add('open');
      function finir(reponse) { elVoile.classList.remove('open'); elVoile.innerHTML = ''; resoudre(reponse); }
      document.getElementById('rffs-conf-oui').onclick = function () { finir(true); };
      document.getElementById('rffs-conf-non').onclick = function () { finir(false); };
    });
  }

  function attendreRole(profil, action) {
    var essais = 0;
    (function boucle() {
      if (role === profil) { action(); return; }
      if (++essais > 40) return;
      setTimeout(boucle, 50);
    })();
  }

  function toast(message, type) {
    if (!elToast) { console.log('[RFFS] ' + message); return; }
    elToast.textContent = message;
    elToast.className = type || 'info';
    elToast.style.display = 'block';
    clearTimeout(minuterieToast);
    minuterieToast = setTimeout(function () { elToast.style.display = 'none'; }, type === 'err' ? 10000 : 4500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', monter);
  else monter();

  /* ── ce que les pages peuvent utiliser ── */
  return {
    esc: esc,
    safeHtml: safeHtml,
    toast: toast,
    confirmer: confirmer,
    version: VERSION,
    estConfigure: function () { return configure; },
    role: function () { return role; },
    onChange: function (f) { ecouteurs.push(f); if (pret) { try { f(role); } catch (e) {} } },
    login: function (profil, action) { ouvrirConnexion(profil || null, action || null); },
    logout: logout,
    requireRole: requireRole,
    saveFiche: saveFiche,
    synchroniser: synchroniser,
    stocker: stocker,
    deleteFiche: deleteFiche,
    getBandeau: getBandeau,
    setBandeau: setBandeau,
    saveAgents: saveAgents,
    rechargerAgents: chargerAgents
  };
})();
