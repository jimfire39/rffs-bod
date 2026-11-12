/* ════════════════════════════════════════════════════════════════════════════
   RFFS BOD — Fichier commun "schémas"
   Chargé par les trois modules qui ont un schéma (générateur RFFS, générateur
   incendie, évaluation). Il apporte deux choses :
     1. Annuler / Rétablir sur le schéma (boutons + Ctrl+Z / Ctrl+Y) ;
     2. Le brouillon automatique : la fiche en cours est gardée sur l'appareil
        et proposée à la réouverture de la page tant qu'elle n'est pas enregistrée.

   Chaque page décrit son schéma en appelant RFFSSchema.init({...}) avec :
     page        nom court de la page (sert de clé au brouillon)
     svgId       identifiant du schéma
     conteneur   sélecteur de la zone où la fiche est affichée
     ancre       sélecteur du bouton « Reset », à côté duquel placer les boutons
     capturer()  renvoie l'état du schéma (positions, rotations…) en données simples
     restaurer(e) remet le schéma dans l'état e, avec les fonctions de la page
     nettoyer(copie)                    (facultatif) retire du brouillon ce que la page rajoute seule
     etatPage()  / apresReprise(extra)  (facultatifs) variables de la page à garder
   ════════════════════════════════════════════════════════════════════════════ */
var RFFSSchema = (function () {
  'use strict';

  var MAX_ETAPES   = 40;                       // nombre d'actions que l'on peut annuler
  var AGE_MAX_MS   = 24 * 3600 * 1000;         // un brouillon de plus de 24 h n'est plus proposé
  var DELAI_SAUVE  = 600;                      // attente après la dernière action avant de sauver

  var cfg = null;
  var pile = [], refaire = [], courant = null, svgRef = null;
  var enRestauration = false;
  var ficheEnregistree = false;                // vrai après « Enregistrer » : plus de brouillon pour cette fiche
  var propositionAffichee = false;             // vrai tant que « Reprendre / Ignorer » est à l'écran
  var minuterie = null;

  function cle()       { return 'rffs_brouillon_' + cfg.page; }
  function svg()       { return document.getElementById(cfg.svgId); }
  function conteneur() { return document.querySelector(cfg.conteneur); }
  function dire(m, t)  { if (window.RFFS && RFFS.toast) RFFS.toast(m, t); }
  function echap(v)    { return window.RFFS ? RFFS.esc(v) : String(v); }

  /* ── 1. ANNULER / RÉTABLIR ───────────────────────────────────────────────── */

  function photo() { return JSON.stringify(cfg.capturer()); }

  // Appelée après chaque action de l'utilisateur : regarde si le schéma a changé.
  function verifier() {
    if (!cfg || enRestauration) return;
    var el = svg();
    if (!el) {                                  // plus de fiche à l'écran
      if (svgRef) { svgRef = null; pile = []; refaire = []; courant = null; if (!propositionAffichee) effacerBrouillon(); }
      return;
    }
    if (el !== svgRef) {                        // une nouvelle fiche vient d'être générée
      svgRef = el; pile = []; refaire = []; courant = photo();
      ficheEnregistree = false; retirerProposition();
      poserBoutons(); majBoutons(); programmerBrouillon();
      return;
    }
    var p = photo();
    if (p !== courant) {
      pile.push(courant); if (pile.length > MAX_ETAPES) pile.shift();
      refaire = []; courant = p;
    }
    poserBoutons(); majBoutons(); programmerBrouillon();
  }

  function appliquer(etat) {
    enRestauration = true;
    try { cfg.restaurer(JSON.parse(etat)); }
    catch (e) { console.error(e); dire('Impossible de revenir en arrière sur ce schéma.', 'err'); }
    finally { enRestauration = false; }
    courant = photo();
    majBoutons(); programmerBrouillon();
  }
  function annuler()  { if (!pile.length || !svg()) return;    refaire.push(courant); appliquer(pile.pop()); }
  function retablir() { if (!refaire.length || !svg()) return; pile.push(courant);    appliquer(refaire.pop()); }

  var STYLE_BTN = 'background:#fff;color:#1F3864;border:1px solid #1F3864;border-radius:6px;padding:4px 10px;font-size:10px;font-weight:600;cursor:pointer;margin-left:4px;';
  function poserBoutons() {
    if (document.getElementById('rffs-undo')) return;
    var ancre = document.querySelector(cfg.ancre);
    if (!ancre || !ancre.parentNode) return;
    var r = document.createElement('button');
    r.type = 'button'; r.id = 'rffs-redo'; r.className = 'no-print rffs-hist'; r.setAttribute('style', STYLE_BTN);
    r.title = 'Rétablir (Ctrl+Y)'; r.textContent = '↷ Rétablir';
    r.addEventListener('click', function (e) { e.stopPropagation(); retablir(); });
    var a = document.createElement('button');
    a.type = 'button'; a.id = 'rffs-undo'; a.className = 'no-print rffs-hist'; a.setAttribute('style', STYLE_BTN);
    a.title = 'Annuler la dernière action (Ctrl+Z)'; a.textContent = '↶ Annuler';
    a.addEventListener('click', function (e) { e.stopPropagation(); annuler(); });
    ancre.parentNode.insertBefore(r, ancre.nextSibling);
    ancre.parentNode.insertBefore(a, r);
  }
  function majBoutons() {
    var a = document.getElementById('rffs-undo'), r = document.getElementById('rffs-redo');
    if (a) { a.disabled = !pile.length;    a.style.opacity = pile.length ? '1' : '.4'; }
    if (r) { r.disabled = !refaire.length; r.style.opacity = refaire.length ? '1' : '.4'; }
  }

  function clavier(e) {
    if (!(e.ctrlKey || e.metaKey) || !svg()) return;
    var t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;     // on laisse l'annulation de saisie du navigateur
    var k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); annuler(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); retablir(); }
  }

  /* ── 2. BROUILLON AUTOMATIQUE ────────────────────────────────────────────── */

  function champs(racine) {
    return Array.prototype.map.call(racine.querySelectorAll('input,select,textarea'), function (c) {
      return (c.type === 'checkbox' || c.type === 'radio') ? { c: c.checked } : { v: c.value };
    });
  }
  function remettreChamps(racine, liste) {
    var els = racine.querySelectorAll('input,select,textarea');
    if (els.length !== liste.length) return false;
    Array.prototype.forEach.call(els, function (c, i) {
      if (c.type === 'checkbox' || c.type === 'radio') c.checked = !!liste[i].c;
      else if (liste[i].v !== undefined) c.value = liste[i].v;
    });
    return true;
  }

  function programmerBrouillon() {
    clearTimeout(minuterie);
    minuterie = setTimeout(sauverBrouillon, DELAI_SAUVE);
  }
  function sauverBrouillon() {
    if (!cfg || ficheEnregistree || enRestauration) return;
    var zone = conteneur();
    if (!zone || !svg()) return;
    try {
      var copie = zone.cloneNode(true);
      copie.querySelectorAll('.rffs-hist').forEach(function (b) { b.remove(); });
      if (cfg.nettoyer) cfg.nettoyer(copie);
      var b = { date: Date.now(), html: copie.innerHTML, champs: champs(zone), schema: cfg.capturer(),
                extra: cfg.etatPage ? cfg.etatPage() : null };
      localStorage.setItem(cle(), JSON.stringify(b));
    } catch (e) {                               // mémoire pleine : le brouillon est simplement abandonné
      try { localStorage.removeItem(cle()); } catch (e2) {}
    }
  }
  function effacerBrouillon() {
    clearTimeout(minuterie);
    try { localStorage.removeItem(cle()); } catch (e) {}
  }
  function lireBrouillon() {
    try {
      var b = JSON.parse(localStorage.getItem(cle()) || 'null');
      if (!b || !b.html || !b.date) return null;
      if (Date.now() - b.date > AGE_MAX_MS) { effacerBrouillon(); return null; }
      return b;
    } catch (e) { return null; }
  }

  function retirerProposition() {
    propositionAffichee = false;
    var p = document.getElementById('rffs-reprise'); if (p) p.remove();
  }
  function proposerReprise() {
    var b = lireBrouillon(), zone = conteneur();
    if (!b || !zone || svg()) return;
    propositionAffichee = true;
    var quand = new Date(b.date).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    var box = document.createElement('div');
    box.id = 'rffs-reprise'; box.className = 'no-print';
    box.setAttribute('style', 'background:#fff8e6;border:2px solid #E8500A;border-radius:10px;padding:14px 16px;margin:0 0 14px;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#1a2433;display:flex;gap:10px;align-items:center;flex-wrap:wrap;');
    box.innerHTML =
      '<span style="flex:1;min-width:200px;"><strong>Fiche en cours retrouvée</strong><br><span style="font-size:12px;color:#5b6676;">Non enregistrée, commencée le ' + echap(quand) + ' sur cet appareil.</span></span>' +
      '<button type="button" id="rffs-reprendre" style="min-height:44px;padding:0 16px;border:none;border-radius:8px;background:#E8500A;color:#fff;font-weight:700;font-size:14px;cursor:pointer;">Reprendre</button>' +
      '<button type="button" id="rffs-ignorer" style="min-height:44px;padding:0 16px;border:1px solid #c9d1dc;border-radius:8px;background:#fff;color:#002F5F;font-weight:700;font-size:14px;cursor:pointer;">Ignorer</button>';
    zone.parentNode.insertBefore(box, zone);
    document.getElementById('rffs-reprendre').addEventListener('click', function (e) { e.stopPropagation(); reprendre(b); });
    document.getElementById('rffs-ignorer').addEventListener('click', function (e) { e.stopPropagation(); retirerProposition(); effacerBrouillon(); });
  }
  function reprendre(b) {
    var zone = conteneur();
    retirerProposition();
    if (!zone) return;
    enRestauration = true;
    try {
      zone.innerHTML = b.html;
      remettreChamps(zone, b.champs || []);
      if (cfg.apresReprise) cfg.apresReprise(b.extra || {});
      if (b.schema) cfg.restaurer(b.schema);
    } catch (e) {
      console.error(e);
      dire('Le brouillon n\'a pas pu être repris entièrement.', 'err');
    } finally { enRestauration = false; }
    svgRef = svg(); pile = []; refaire = []; courant = svgRef ? photo() : null;
    ficheEnregistree = false;
    poserBoutons(); majBoutons();
    dire('Fiche en cours reprise.', 'ok');
  }

  /* ── 3. DÉMARRAGE ────────────────────────────────────────────────────────── */

  function init(config) {
    cfg = config;
    // Après chaque geste (clic, fin de glisser, saisie), une fois que la page a fini son travail.
    ['mouseup', 'touchend', 'click', 'keyup', 'change', 'input'].forEach(function (ev) {
      document.addEventListener(ev, function () { setTimeout(verifier, 0); }, true);
    });
    document.addEventListener('keydown', clavier);
    // Filet de sécurité : si la fiche est remplacée sans geste de l'utilisateur, on le voit quand même.
    function surveiller() {
      var zone = conteneur();
      if (zone && window.MutationObserver) new MutationObserver(function () { setTimeout(verifier, 0); }).observe(zone, { childList: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', surveiller); else surveiller();
    // La fiche vient d'être enregistrée : plus besoin de brouillon.
    document.addEventListener('rffs:fiche-enregistree', function () { ficheEnregistree = true; effacerBrouillon(); });
    // Sauvegarde de sécurité quand l'onglet passe en arrière-plan ou se ferme.
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') sauverBrouillon(); });
    window.addEventListener('pagehide', sauverBrouillon);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', proposerReprise);
    else proposerReprise();
  }

  return { init: init, annuler: annuler, retablir: retablir, verifier: verifier,
           etat: function () { return { annulables: pile.length, retablissables: refaire.length }; } };
})();
