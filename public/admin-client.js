// admin-client.js - Version adaptée de client.js pour le canal administrateur

// Configuration initiale et variables
const socket = io({
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
});

// Éléments DOM
const loginContainer = document.getElementById('login-container');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginButton = document.getElementById('login-button');
const errorMessage = document.getElementById('error-message');
const adminStatus = document.getElementById('admin-status');
const chatAreaDiv = document.getElementById('chat-area');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const securityInfoDiv = document.getElementById('security-info');
const myFingerprintSpan = document.getElementById('my-fingerprint');
const peerFingerprintSpan = document.getElementById('peer-fingerprint');
const peerNameFingerprintSpan = document.getElementById('peer-name-fingerprint');
const audioControlsDiv = document.getElementById('audio-controls');
const recordButton = document.getElementById('record-button');
const stopRecordButton = document.getElementById('stop-record-button');
const audioStatus = document.getElementById('audio-status');
const soundToggle = document.getElementById('sound-toggle');

// État du client
let myName = '';
let myUserId = '';
let myDisplayName = '';
let myAuthToken = '';
let myKeyPair = null;
let myPublicKeyJwk = null;
let peerPublicKey = null;
let peerPublicKeyJwk = null;
let peerName = '';
let peerId = '';
let adminChannelId = "admin-persistent-channel-42a1b3c4"; // Doit correspondre à l'ID défini sur le serveur
let isAuthenticated = false;

// Variables pour l'enregistrement audio (identiques à client.js)
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let audioBlob = null;
let audioContext = null;
const MAX_AUDIO_SIZE = 1024 * 1024 * 5; // 5MB max
const MAX_RECORDING_TIME = 15000; // 15 secondes max
const CHUNK_SIZE = 200 * 1024; // 200KB par fragment
let recordingTimeout = null;
let audioChunkBuffer = {};

// Sons de notification
let notificationSounds = {
    userJoin: null,
    message: null,
    audioMessage: null
};

// --- FONCTIONS D'AUTHENTIFICATION ---

// Fonction d'initialisation
function initAdminChannel() {
    updateAdminStatus("Bienvenue sur le canal administrateur sécurisé");
    
    // Charger les sons de notification
    loadNotificationSounds();
    
    // Ajouter les écouteurs d'événements pour le formulaire de connexion
    if (loginButton) {
        loginButton.addEventListener('click', attemptLogin);
    }
    
    if (passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') attemptLogin();
        });
    }
    
    // Vérifier si un token est stocké dans le localStorage
    const savedToken = localStorage.getItem('adminAuthToken');
    if (savedToken) {
        myAuthToken = savedToken;
        myUserId = localStorage.getItem('adminUserId') || '';
        myDisplayName = localStorage.getItem('adminDisplayName') || '';
        
        // Tenter une reconnexion automatique
        autoConnect();
    }
}

// Mise à jour du statut
function updateAdminStatus(message, isError = false) {
    if (adminStatus) {
        adminStatus.textContent = message;
        adminStatus.style.color = isError ? 'red' : '#333';
        adminStatus.style.borderColor = isError ? 'red' : '#4CAF50';
    }
    console.log("Admin Status:", message);
}

// Tentative de connexion
async function attemptLogin() {
    if (!usernameInput || !passwordInput) return;
    
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    
    if (!username || !password) {
        showError("Veuillez remplir tous les champs");
        return;
    }
    
    loginButton.disabled = true;
    updateAdminStatus("Tentative de connexion...");
    
    try {
        const response = await fetch('/admin/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (!data.success) {
            showError(data.message || "Échec de l'authentification");
            loginButton.disabled = false;
            return;
        }
        
        // Authentification réussie
        myAuthToken = data.token;
        myUserId = data.user.id;
        myDisplayName = data.user.displayName;
        
        // Sauvegarder les informations dans localStorage
        localStorage.setItem('adminAuthToken', myAuthToken);
        localStorage.setItem('adminUserId', myUserId);
        localStorage.setItem('adminDisplayName', myDisplayName);
        
        // Cacher le formulaire de connexion
        if (loginContainer) loginContainer.style.display = 'none';
        
        isAuthenticated = true;
        updateAdminStatus(`Authentifié en tant que ${myDisplayName}`);
        
        // Générer les clés et se connecter au canal
        await initializeCryptoAndConnect();
        
    } catch (error) {
        console.error("Erreur lors de la tentative de connexion:", error);
        showError("Erreur de connexion au serveur");
        loginButton.disabled = false;
    }
}

// Tenter une reconnexion automatique avec le token stocké
async function autoConnect() {
    if (!myAuthToken) return;
    
    updateAdminStatus("Tentative de reconnexion automatique...");
    
    try {
        // Dans un vrai système, on vérifierait la validité du token
        // Ici on va simplement essayer de l'utiliser pour se connecter
        isAuthenticated = true;
        
        // Cacher le formulaire de connexion
        if (loginContainer) loginContainer.style.display = 'none';
        
        // Générer les clés et se connecter au canal
        await initializeCryptoAndConnect();
        
    } catch (error) {
        console.error("Échec de la reconnexion automatique:", error);
        updateAdminStatus("La session a expiré, veuillez vous reconnecter", true);
        logout();
    }
}

// Déconnexion
function logout() {
    localStorage.removeItem('adminAuthToken');
    localStorage.removeItem('adminUserId');
    localStorage.removeItem('adminDisplayName');
    
    myAuthToken = '';
    myUserId = '';
    myDisplayName = '';
    isAuthenticated = false;
    
    // Réinitialiser l'interface
    resetChatState();
    
    // Afficher le formulaire de connexion
    if (loginContainer) loginContainer.style.display = 'block';
    if (chatAreaDiv) chatAreaDiv.style.display = 'none';
    
    // Activer le bouton de connexion
    if (loginButton) loginButton.disabled = false;
    
    // Effacer les champs
    if (usernameInput) usernameInput.value = '';
    if (passwordInput) passwordInput.value = '';
    
    updateAdminStatus("Déconnecté");
}

// Afficher un message d'erreur
function showError(message) {
    if (errorMessage) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
        
        // Cacher le message après 5 secondes
        setTimeout(() => {
            errorMessage.style.display = 'none';
        }, 5000);
    }
    
    updateAdminStatus(message, true);
}

// --- INITIALISATION DE LA CRYPTO ET CONNEXION ---

async function initializeCryptoAndConnect() {
    // Vérifier Web Crypto API
    if (!window.crypto || !window.crypto.subtle) {
        showError("Votre navigateur ne supporte pas l'API Web Crypto nécessaire");
        return;
    }
    
    updateAdminStatus("Génération des clés de chiffrement...");
    
    try {
        myKeyPair = await generateKeyPair();
        myPublicKeyJwk = await exportPublicKey(myKeyPair.publicKey);
        
        if (!myPublicKeyJwk) {
            throw new Error("Impossible d'exporter la clé publique");
        }
        
        // Mettre à jour l'empreinte locale
        await updateSecurityInfo(myPublicKeyJwk, null, null);
        
        // Se connecter au canal administrateur
        updateAdminStatus("Connexion au canal administrateur...");
        socket.emit('joinAdminChannel', { 
            token: myAuthToken, 
            publicKey: myPublicKeyJwk 
        });
        
    } catch (error) {
        console.error("Erreur d'initialisation cryptographique:", error);
        showError("Échec de l'initialisation cryptographique");
        logout();
    }
}

// --- FONCTIONS CRYPTO (reprises de client.js) ---

async function generateKeyPair() {
    try {
        const keyPair = await window.crypto.subtle.generateKey(
            { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([0x01, 0x00, 0x01]), hash: "SHA-256" },
            true, ["encrypt", "decrypt"]
        );
        console.log("Paire de clés générée.");
        return keyPair;
    } catch (error) {
        console.error("Erreur critique - génération clés:", error);
        updateAdminStatus("Erreur: Impossible de générer les clés cryptographiques.", true);
        throw error;
    }
}

async function exportPublicKey(key) {
    if (!key) return null;
    try {
        return await window.crypto.subtle.exportKey("jwk", key);
    } catch (error) {
        console.error("Erreur exportation clé publique:", error);
        updateAdminStatus("Erreur interne lors de la préparation de la clé.", true);
        return null;
    }
}

async function importPublicKey(jwk) {
     if (!jwk) return null;
    try {
        return await window.crypto.subtle.importKey(
            "jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
        );
    } catch (error) {
        console.error("Erreur importation clé publique:", error);
        updateAdminStatus("Erreur: Impossible d'utiliser la clé publique reçue.", true);
        return null;
    }
}

async function encryptMessage(plainText, publicKey) {
    if (!publicKey) { console.error("Clé publique pair manquante pour chiffrement."); return null; }
    try {
        const encoded = new TextEncoder().encode(plainText);
        return await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, encoded);
    } catch (error) {
        console.error("Erreur de chiffrement:", error);
        updateAdminStatus("Erreur: Impossible de chiffrer le message.", true);
        return null;
    }
}

async function decryptMessage(cipherTextBuffer) {
     if (!myKeyPair || !myKeyPair.privateKey) { console.error("Clé privée manquante pour déchiffrement."); return null; }
    try {
        const decrypted = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, myKeyPair.privateKey, cipherTextBuffer);
        return new TextDecoder().decode(decrypted);
    } catch (error) {
        console.error("Erreur de déchiffrement:", error);
        return null;
    }
}
// Fonctions pour chiffrer/déchiffrer des données binaires (audio)
async function encryptBinaryData(data, publicKey) {
    if (!publicKey) { console.error("Clé publique pair manquante pour chiffrement."); return null; }
    
    try {
        // Pour les gros fichiers audio, nous utilisons un chiffrement hybride:
        // 1. Générer une clé AES pour chiffrer les données audio
        // 2. Chiffrer la clé AES avec RSA (clé publique du destinataire)
        // 3. Envoyer la clé AES chiffrée et les données audio chiffrées

        // Générer une clé AES aléatoire pour cette session
        const aesKey = await window.crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );

        // Générer un IV aléatoire
        const iv = window.crypto.getRandomValues(new Uint8Array(12));

        // Chiffrer les données audio avec AES-GCM
        const encryptedAudio = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            aesKey,
            data
        );

        // Exporter la clé AES pour la chiffrer avec RSA
        const exportedAesKey = await window.crypto.subtle.exportKey("raw", aesKey);
        
        // Chiffrer la clé AES avec la clé RSA publique du destinataire
        const encryptedAesKey = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            publicKey,
            exportedAesKey
        );

        // Retourner les éléments nécessaires au déchiffrement
        return {
            encryptedData: encryptedAudio,
            encryptedKey: encryptedAesKey,
            iv: iv
        };
    } catch (error) {
        console.error("Erreur de chiffrement audio:", error);
        updateAdminStatus("Erreur: Impossible de chiffrer le message audio.", true);
        return null;
    }
}

async function decryptBinaryData(encryptedData, encryptedKey, iv) {
    if (!myKeyPair || !myKeyPair.privateKey) { 
        console.error("Clé privée manquante pour déchiffrement."); 
        return null; 
    }
    
    try {
        // Déchiffrer la clé AES avec notre clé RSA privée
        const aesKeyBuffer = await window.crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            myKeyPair.privateKey,
            encryptedKey
        );

        // Importer la clé AES déchiffrée
        const aesKey = await window.crypto.subtle.importKey(
            "raw",
            aesKeyBuffer,
            { name: "AES-GCM", length: 256 },
            false,
            ["decrypt"]
        );

        // Déchiffrer les données audio avec la clé AES
        const decryptedData = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            aesKey,
            encryptedData
        );

        return decryptedData;
    } catch (error) {
        console.error("Erreur de déchiffrement audio:", error);
        return null;
    }
}

// Génère une empreinte lisible (hex) d'une clé publique (JWK) - NON ROBUSTE/CANONIQUE
async function generateFingerprint(jwkPublicKey) {
    if (!jwkPublicKey) return "Clé manquante";
    try {
        const keyString = JSON.stringify(jwkPublicKey, Object.keys(jwkPublicKey).sort());
        const keyBuffer = new TextEncoder().encode(keyString);
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', keyBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return `${hashHex.substring(0, 6)}:${hashHex.substring(hashHex.length - 6)}`;
    } catch (error) {
        console.error("Erreur génération empreinte:", error);
        return "Erreur calcul";
    }
}

// --- NOTIFICATIONS SONORES ---

// Chargement des sons de notification
function loadNotificationSounds() {
    try {
        // Création des objets Audio
        notificationSounds.userJoin = new Audio('/sounds/user-join.mp3');
        notificationSounds.message = new Audio('/sounds/message.mp3');
        notificationSounds.audioMessage = new Audio('/sounds/audio-message.mp3');
        
        // Préchargement des sons
        Object.values(notificationSounds).forEach(sound => {
            if (sound) {
                sound.load();
                // Réduire le volume pour ne pas surprendre les utilisateurs
                sound.volume = 0.5;
            }
        });
        
        console.log("Sons de notification chargés avec succès.");
    } catch (error) {
        console.error("Erreur lors du chargement des sons de notification:", error);
    }
}

// Fonction pour jouer un son de notification
function playNotificationSound(soundType) {
    // Vérifier si l'API Audio est disponible
    if (!window.Audio) {
        console.warn("L'API Audio n'est pas supportée par ce navigateur.");
        return;
    }
    
    // Vérifier si les notifications sonores sont activées
    if (!localStorage.getItem('soundNotificationsEnabled')) {
        // Par défaut, les sons sont activés - donc si le paramètre n'existe pas, on active
        localStorage.setItem('soundNotificationsEnabled', 'true');
    }
    
    if (localStorage.getItem('soundNotificationsEnabled') === 'false') {
        return; // Sons désactivés par l'utilisateur
    }
    
    // Vérifier si le son demandé existe
    const sound = notificationSounds[soundType];
    if (!sound) {
        console.warn(`Type de son de notification inconnu: ${soundType}`);
        return;
    }
    
    try {
        // Réinitialiser le son s'il était déjà en cours de lecture
        sound.pause();
        sound.currentTime = 0;
        
        // Jouer le son
        sound.play().catch(error => {
            console.warn(`Impossible de jouer le son de notification: ${error.message}`);
        });
    } catch (error) {
        console.error("Erreur lors de la lecture du son de notification:", error);
    }
}

// Notification visuelle (highlight) à un élément
function addVisualNotification(element) {
    if (!element) return;
    
    // Supprimer la classe si elle est déjà présente
    element.classList.remove('notification-highlight');
    
    // Forcer un reflow pour réinitialiser l'animation
    void element.offsetWidth;
    
    // Ajouter la classe pour déclencher l'animation
    element.classList.add('notification-highlight');
    
    // Optionnel: supprimer la classe après l'animation
    setTimeout(() => {
        element.classList.remove('notification-highlight');
    }, 1000); // 1000ms = durée de l'animation
}

// --- LOGIQUE UI ET SOCKET.IO ---

function updateStatus(message, isError = false) {
    updateAdminStatus(message, isError);
}

function updateAudioStatus(message, isError = false) {
    if (audioStatus) {
        audioStatus.textContent = message;
        audioStatus.style.color = isError ? 'red' : 'green';
    }
}

function addMessage(text, sender = 'system') {
    if (!messagesDiv) return; // Ne rien faire si la zone de message n'existe pas
    const p = document.createElement('p');
    p.textContent = text;

    if (sender === 'me') { p.className = 'my-message'; }
    else if (sender === 'other') { p.className = 'other-message'; }
    else { p.className = 'system-message'; }

    messagesDiv.appendChild(p);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Ajouter un message audio au chat
function addAudioMessage(audioBlob, sender = 'system') {
    if (!messagesDiv) return;
    
    const messageContainer = document.createElement('div');
    messageContainer.className = sender === 'me' ? 'my-message' : sender === 'other' ? 'other-message' : 'system-message';
    
    const label = document.createElement('p');
    label.textContent = sender === 'me' ? `${myDisplayName} (vous) [Message Audio]` : 
                        sender === 'other' ? `${peerName} [Message Audio]` : 
                        '[Message Audio Système]';
    messageContainer.appendChild(label);
    
    // Créer un élément audio avec les contrôles
    const audio = document.createElement('audio');
    audio.controls = true;
    
    // Créer une URL pour le blob audio
    const audioURL = URL.createObjectURL(audioBlob);
    audio.src = audioURL;
    
    messageContainer.appendChild(audio);
    messagesDiv.appendChild(messageContainer);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Met à jour l'affichage des empreintes
async function updateSecurityInfo(localJwk, remoteJwk, remoteName) {
    if (!securityInfoDiv || !myFingerprintSpan || !peerFingerprintSpan || !peerNameFingerprintSpan) return;
    myFingerprintSpan.textContent = await generateFingerprint(localJwk);
    peerNameFingerprintSpan.textContent = remoteName || 'votre correspondant';
    peerFingerprintSpan.textContent = await generateFingerprint(remoteJwk);
    securityInfoDiv.style.display = (localJwk && remoteJwk) ? 'block' : 'none';
}

// Initialisation de l'enregistrement audio
async function initAudioRecording() {
    try {
        // Vérifier si l'API MediaRecorder est disponible
        if (!window.MediaRecorder) {
            console.error("MediaRecorder API non disponible dans ce navigateur");
            updateAudioStatus("Enregistrement audio non supporté par votre navigateur", true);
            return false;
        }
        
        // Demander la permission d'accéder au microphone
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Créer un nouveau MediaRecorder avec un débit réduit
        const options = { 
            mimeType: 'audio/webm;codecs=opus', 
            audioBitsPerSecond: 16000 // Débit réduit pour des fichiers plus légers
        };
        
        try {
            mediaRecorder = new MediaRecorder(stream, options);
        } catch (e) {
            // Si les options ne sont pas supportées, essayer sans options
            console.warn("Options audio non supportées, utilisation des paramètres par défaut");
            mediaRecorder = new MediaRecorder(stream);
        }
        
        // Configurer les événements
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        
        mediaRecorder.onstop = async () => {
            // Effacer le timeout s'il existe encore
            if (recordingTimeout) {
                clearTimeout(recordingTimeout);
                recordingTimeout = null;
            }
            
            // Créer un blob à partir des chunks
            audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            
            // Vérifier la taille du fichier audio
            if (audioBlob.size > MAX_AUDIO_SIZE) {
                updateAudioStatus(`Message audio trop volumineux (${Math.round(audioBlob.size/1024/1024)}MB > 5MB)`, true);
                audioChunks = [];
                isRecording = false;
                return;
            }
            
            // Préparer l'envoi
            updateAudioStatus("Préparation de l'envoi...");
            
            try {
                // Convertir le blob en ArrayBuffer pour le chiffrement
                const arrayBuffer = await audioBlob.arrayBuffer();
                
                // Vérifier si le destinataire est connecté
                if (!peerPublicKey) {
                    updateAudioStatus("Erreur: Destinataire non connecté", true);
                    return;
                }
                
                // Générer un ID unique pour ce message audio
                const messageId = Date.now().toString() + "-" + Math.random().toString(36).substr(2, 9);
                
                // Calculer le nombre de morceaux nécessaires
                const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);
                console.log(`Découpage du message audio en ${totalChunks} morceaux`);
                
                // Ajouter le message audio à notre interface tout de suite
                addAudioMessage(audioBlob, 'me');
                updateAudioStatus(`Envoi du message audio... (0/${totalChunks})`);
                
                // Envoyer chaque morceau séparément
                for (let i = 0; i < totalChunks; i++) {
                    const start = i * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, arrayBuffer.byteLength);
                    const chunk = arrayBuffer.slice(start, end);
                    
                    // Chiffrer ce morceau
                    const encryptedData = await encryptBinaryData(chunk, peerPublicKey);
                    if (!encryptedData) {
                        updateAudioStatus(`Erreur de chiffrement (morceau ${i+1}/${totalChunks})`, true);
                        return;
                    }
                    
                    // Envoyer le morceau avec ses métadonnées
                    socket.emit('sendAudioChunk', {
                        encryptedAudio: encryptedData.encryptedData,
                        encryptedKey: encryptedData.encryptedKey,
                        iv: encryptedData.iv,
                        chunkIndex: i,
                        totalChunks: totalChunks,
                        messageId: messageId
                    });
                    
                    updateAudioStatus(`Envoi du message audio... (${i+1}/${totalChunks})`);
                    
                    // Petite pause pour éviter de surcharger le réseau
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                
                updateAudioStatus("Message audio envoyé");
                
            } catch (error) {
                console.error("Erreur lors de l'envoi du message audio:", error);
                updateAudioStatus("Erreur lors de l'envoi du message audio", true);
            }
            
            // Réinitialiser l'état
            audioChunks = [];
            isRecording = false;
        };
        
        return true;
    } catch (error) {
        console.error("Erreur lors de l'initialisation de l'enregistrement audio:", error);
        updateAudioStatus("Erreur d'accès au microphone. Vérifiez les permissions.", true);
        return false;
    }
}

// Fonction pour démarrer l'enregistrement
function startRecording() {
    if (!mediaRecorder || isRecording) return;
    
    audioChunks = [];
    mediaRecorder.start();
    isRecording = true;
    updateAudioStatus("Enregistrement en cours... (max 15s)");
    
    if (recordButton) recordButton.style.display = 'none';
    if (stopRecordButton) stopRecordButton.style.display = 'inline-block';
    
    // Définir un timeout pour limiter la durée d'enregistrement
    recordingTimeout = setTimeout(() => {
        if (isRecording && mediaRecorder) {
            updateAudioStatus("Durée maximale atteinte (15s)");
            stopRecording();
        }
    }, MAX_RECORDING_TIME);
}

// Fonction pour arrêter l'enregistrement
function stopRecording() {
    if (!mediaRecorder || !isRecording) return;
    
    // Effacer le timeout si l'utilisateur arrête manuellement
    if (recordingTimeout) {
        clearTimeout(recordingTimeout);
        recordingTimeout = null;
    }
    
    mediaRecorder.stop();
    updateAudioStatus("Traitement de l'enregistrement...");
    
    if (recordButton) recordButton.style.display = 'inline-block';
    if (stopRecordButton) stopRecordButton.style.display = 'none';
}

// Ajoutez cette fonction pour assembler les morceaux audio reçus
function processAudioChunks(messageId, senderName) {
    const chunks = audioChunkBuffer[messageId];
    if (!chunks || !chunks.ready) return;
    
    // Récupérer tous les morceaux dans l'ordre
    const sortedChunks = Array(chunks.totalChunks).fill(null);
    for (const chunk of chunks.data) {
        sortedChunks[chunk.index] = chunk.data;
    }
    
    // Vérifier si tous les morceaux sont présents
    if (sortedChunks.includes(null)) {
        console.error(`Message audio incomplet: certains morceaux manquent (${messageId})`);
        addMessage(`[Message audio incomplet reçu de ${senderName}]`, 'system');
        delete audioChunkBuffer[messageId];
        return;
    }
    
    // Concaténer tous les morceaux dans un seul ArrayBuffer
    const totalLength = sortedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const completeBuffer = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const chunk of sortedChunks) {
        completeBuffer.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    }
    
    // Créer un blob audio à partir du buffer complet
    const audioBlob = new Blob([completeBuffer], { type: 'audio/webm' });
    
    // Ajouter le message audio à l'interface
    addAudioMessage(audioBlob, 'other');
    
    // Notification sonore
    playNotificationSound('audioMessage');
    
    // Nettoyer
    delete audioChunkBuffer[messageId];
}

// Réinitialise l'état et l'UI
function resetChatState() {
    console.log("Réinitialisation de l'état du chat admin.");
    myName = '';
    myKeyPair = null;
    myPublicKeyJwk = null;
    peerPublicKey = null;
    peerPublicKeyJwk = null;
    peerName = '';
    peerId = '';

    if (chatAreaDiv) chatAreaDiv.style.display = 'none';
    if (messagesDiv) messagesDiv.innerHTML = '';
    if (messageInput) { messageInput.value = ''; messageInput.disabled = true; }
    if (sendButton) sendButton.disabled = true;
    if (securityInfoDiv) securityInfoDiv.style.display = 'none';
    if (myFingerprintSpan) myFingerprintSpan.textContent = '';
    if (peerFingerprintSpan) peerFingerprintSpan.textContent = '';
    if (peerNameFingerprintSpan) peerNameFingerprintSpan.textContent = 'votre correspondant';
    
    // Réinitialiser l'état audio
    if (audioControlsDiv) audioControlsDiv.style.display = 'none';
    if (audioStatus) audioStatus.textContent = '';
    if (recordButton) recordButton.style.display = 'inline-block';
    if (stopRecordButton) stopRecordButton.style.display = 'none';
    isRecording = false;
    audioChunks = [];
    audioBlob = null;
    
    // Arrêter le MediaRecorder s'il est actif
    if (mediaRecorder && isRecording) {
        try {
            mediaRecorder.stop();
        } catch (e) {
            console.error("Erreur lors de l'arrêt du MediaRecorder:", e);
        }
    }
    
    // Libérer les ressources du microphone
    if (mediaRecorder && mediaRecorder.stream) {
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    
    mediaRecorder = null;
}

// Fonction pour envoyer un message
async function sendMessage() {
    const messageText = messageInput.value.trim();
    if (!messageText) return;
    if (!peerPublicKey) { addMessage("[Erreur: Destinataire non prêt ou clé manquante]", 'system'); return; }

    messageInput.disabled = true; sendButton.disabled = true;
    updateStatus("Chiffrement...");
    const encryptedBuffer = await encryptMessage(messageText, peerPublicKey);

    if (encryptedBuffer) {
        updateStatus("Envoi...");
        socket.emit('sendMessage', { encryptedMessage: encryptedBuffer });
        addMessage(`${myDisplayName} (vous): ${messageText}`, 'me');
        messageInput.value = '';
        updateStatus("Prêt.");
    } else {
        updateStatus("Erreur de chiffrement, message non envoyé.", true);
    }
    if(peerPublicKey) { messageInput.disabled = false; sendButton.disabled = false; messageInput.focus(); }
}

// --- ÉCOUTEURS D'ÉVÉNEMENTS SOCKET.IO ET UI ---

// Initialisation au chargement de la page
window.onload = () => {
    console.log("Page Canal Admin chargée");
    initAdminChannel();
};

// Écouteurs d'événements pour l'interface utilisateur
if (sendButton && messageInput) {
    sendButton.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
}

// Écouteurs pour l'enregistrement audio
if (recordButton) {
    recordButton.addEventListener('click', async () => {
        if (!peerPublicKey) {
            updateAudioStatus("Impossible d'enregistrer : destinataire non connecté", true);
            return;
        }
        
        // Initialisation de l'enregistrement si nécessaire
        if (!mediaRecorder) {
            const initSuccess = await initAudioRecording();
            if (!initSuccess) return;
        }
        
        startRecording();
    });
}

if (stopRecordButton) {
    stopRecordButton.addEventListener('click', () => {
        stopRecording();
    });
}

// Écouteur pour activer/désactiver les sons
if (soundToggle) {
    soundToggle.addEventListener('change', function() {
        localStorage.setItem('soundNotificationsEnabled', this.checked ? 'true' : 'false');
        console.log(`Notifications sonores ${this.checked ? 'activées' : 'désactivées'}`);
    });
    
    // Initialiser l'état selon le localStorage
    soundToggle.checked = localStorage.getItem('soundNotificationsEnabled') !== 'false';
}

// --- ÉCOUTEURS D'ÉVÉNEMENTS SOCKET.IO ---

socket.on('connect', () => { 
    console.log(`Connecté au serveur socket: ${socket.id}`); 
    
    // Si nous sommes déjà authentifiés, tenter de rejoindre le canal admin
    if (isAuthenticated && myAuthToken && myKeyPair && myPublicKeyJwk) {
        socket.emit('joinAdminChannel', { 
            token: myAuthToken, 
            publicKey: myPublicKeyJwk 
        });
    }
});

socket.on('connect_error', (err) => { 
    console.error('Échec connexion socket:', err.message); 
    updateStatus(`Serveur injoignable: ${err.message}. Tentatives...`, true); 
});

socket.on('disconnect', (reason) => {
    console.log(`Déconnecté: ${reason}`);
    let statusMsg = `Déconnexion: ${reason}.`;
    if (reason !== 'io client disconnect' && reason !== 'io server disconnect') 
        statusMsg += ' Tentative reconnexion...';
    updateStatus(statusMsg, true);
    if(messageInput) messageInput.disabled = true; 
    if(sendButton) sendButton.disabled = true; 
    if(securityInfoDiv) securityInfoDiv.style.display = 'none';
    if(audioControlsDiv) audioControlsDiv.style.display = 'none';
    peerPublicKey = null; 
    peerPublicKeyJwk = null;
});

// Événements spécifiques au canal admin
socket.on('waitingForPeerAdmin', (data) => {
    updateStatus(`Canal administrateur initialisé. En attente d'un autre administrateur...`);
    if(chatAreaDiv) chatAreaDiv.style.display = 'block';
    addMessage("Vous êtes le premier administrateur connecté. Veuillez attendre qu'un autre administrateur se connecte.", 'system');
});

socket.on('adminChannelJoined', async (data) => {
    console.log("Canal administrateur rejoint:", data);
    
    if (!data.peers || data.peers.length === 0) {
        updateStatus("Connecté au canal administrateur. Aucun autre administrateur présent.");
        return;
    }
    
    // Établir la connexion avec le premier pair trouvé
    const peer = data.peers[0];
    peerId = peer.id;
    peerName = peer.name;
    peerPublicKeyJwk = peer.publicKey;
    peerPublicKey = await importPublicKey(peerPublicKeyJwk);
    
    if (peerPublicKey) {
        updateStatus(`Connecté avec ${peerName}. Vérifiez les empreintes !`);
        await updateSecurityInfo(myPublicKeyJwk, peerPublicKeyJwk, peerName);
        if(chatAreaDiv) chatAreaDiv.style.display = 'block';
        if(messageInput) messageInput.disabled = false; 
        if(sendButton) sendButton.disabled = false;
        if(audioControlsDiv) audioControlsDiv.style.display = 'block';
        if(messageInput) messageInput.focus();
        
        addMessage(`Connecté au canal administrateur avec ${peerName}. N'oubliez pas de vérifier les empreintes.`, 'system');
        
        // Notification sonore
        playNotificationSound('userJoin');
    } else {
        updateStatus(`Erreur lors de l'importation de la clé de ${peerName}`, true);
    }
});

socket.on('adminPeerJoined', async (data) => {
    console.log("Pair administrateur connecté:", data);
    
    if (!data.peerPublicKey || !data.peerName || !data.peerId) {
        updateStatus("Données de pair incomplètes.", true);
        return;
    }
    
    peerId = data.peerId;
    peerName = data.peerName;
    peerPublicKeyJwk = data.peerPublicKey;
    peerPublicKey = await importPublicKey(peerPublicKeyJwk);
    
    if (peerPublicKey) {
        updateStatus(`Connecté avec ${peerName}. Vérifiez les empreintes !`);
        await updateSecurityInfo(myPublicKeyJwk, peerPublicKeyJwk, peerName);
        if(chatAreaDiv) chatAreaDiv.style.display = 'block';
        if(messageInput) messageInput.disabled = false; 
        if(sendButton) sendButton.disabled = false;
        if(audioControlsDiv) audioControlsDiv.style.display = 'block';
        if(messageInput) messageInput.focus();
        
        addMessage(`${peerName} a rejoint le canal administrateur. N'oubliez pas de vérifier les empreintes.`, 'system');
        
        // Notification sonore
        playNotificationSound('userJoin');
        // Notification visuelle
        addVisualNotification(chatAreaDiv);
    } else {
        updateStatus(`Erreur clé ${peerName}. Chat bloqué.`, true);
        if(messageInput) messageInput.disabled = true; 
        if(sendButton) sendButton.disabled = true;
        if(audioControlsDiv) audioControlsDiv.style.display = 'none';
    }
});
socket.on('adminPeerDisconnected', (data) => {
    if (data.peerId === peerId) {
        const disconnectType = data.temporary ? "temporairement déconnecté" : "quitté";
        addMessage(`${data.peerName || 'L\'autre administrateur'} s'est ${disconnectType}.`, 'system');
        updateStatus(`${data.peerName || 'L\'autre administrateur'} s'est ${disconnectType}. ${data.temporary ? 'Vous pouvez continuer à écrire des messages qui seront synchronisés lors de sa reconnexion.' : 'Le chat est terminé.'}`);
        
        if (!data.temporary) {
            // Si déconnexion définitive, désactiver l'interface
            if(messageInput) messageInput.disabled = true; 
            if(sendButton) sendButton.disabled = true;
            if(audioControlsDiv) audioControlsDiv.style.display = 'none';
            peerPublicKey = null;
            peerPublicKeyJwk = null;
            peerId = '';
            peerName = '';
        }
    }
});

socket.on('adminChannelFull', () => {
    updateStatus("Le canal administrateur est déjà occupé par deux administrateurs.", true);
    addMessage("Impossible de rejoindre le canal: deux administrateurs sont déjà connectés.", 'system');
});

socket.on('sessionReplaced', (data) => {
    updateStatus("Votre session a été remplacée par une nouvelle connexion.", true);
    addMessage("Vous avez été déconnecté car vous vous êtes connecté depuis un autre appareil ou navigateur.", 'system');
    logout();
});

socket.on('reconnectedToAdminChannel', () => {
    updateStatus("Vous êtes reconnecté au canal administrateur.");
    addMessage("Vous avez été reconnecté au canal administrateur.", 'system');
});

socket.on('adminUserReconnected', async (data) => {
    // Un autre admin s'est reconnecté avec la même identité
    console.log("Admin reconnecté:", data);
    
    if (!data.peerPublicKey || !data.peerName || !data.peerId) {
        return;
    }
    
    peerId = data.peerId;
    peerName = data.peerName;
    peerPublicKeyJwk = data.peerPublicKey;
    peerPublicKey = await importPublicKey(peerPublicKeyJwk);
    
    if (peerPublicKey) {
        updateStatus(`${peerName} s'est reconnecté.`);
        await updateSecurityInfo(myPublicKeyJwk, peerPublicKeyJwk, peerName);
        if(messageInput) messageInput.disabled = false; 
        if(sendButton) sendButton.disabled = false;
        if(audioControlsDiv) audioControlsDiv.style.display = 'block';
        
        addMessage(`${peerName} s'est reconnecté au canal.`, 'system');
        
        // Notification sonore
        playNotificationSound('userJoin');
    }
});

socket.on('errorJoining', (data) => {
    showError(data.message || "Erreur lors de la connexion au canal administrateur");
    
    // Si l'erreur concerne l'authentification, se déconnecter
    if (data.message && data.message.includes("Authentification")) {
        logout();
    }
});

socket.on('receiveMessage', async (data) => {
    if (!myKeyPair) return;
    if (!data?.senderName || !data.encryptedMessage) {
        console.warn("Message reçu invalide:", data);
        return;
    }
    
    console.log(`Message chiffré reçu de ${data.senderName}`);
    const decryptedText = await decryptMessage(data.encryptedMessage);
    
    if (decryptedText === null) {
        addMessage(`[Impossible de déchiffrer le message de ${data.senderName}]`, 'system');
    } else {
        addMessage(`${data.senderName}: ${decryptedText}`, 'other');
        
        // Notification sonore
        playNotificationSound('message');
        
        // Notification visuelle
        addVisualNotification(messagesDiv);
    }
});

socket.on('receiveAudioChunk', async (data) => {
    if (!myKeyPair) return;
    if (!data?.senderName || !data.encryptedAudio || !data.encryptedKey || !data.iv || 
        data.messageId === undefined || data.chunkIndex === undefined || data.totalChunks === undefined) {
        console.warn("Morceau audio reçu invalide:", data);
        return;
    }
    
    const { messageId, chunkIndex, totalChunks, senderName } = data;
    console.log(`Morceau audio reçu: ${chunkIndex+1}/${totalChunks} de ${senderName}`);
    
    try {
        // Déchiffrer le morceau audio
        const decryptedData = await decryptBinaryData(data.encryptedAudio, data.encryptedKey, data.iv);
        
        if (!decryptedData) {
            console.error(`Impossible de déchiffrer le morceau audio ${chunkIndex+1}/${totalChunks}`);
            return;
        }
        
        // Initialiser le buffer pour ce message s'il n'existe pas encore
        if (!audioChunkBuffer[messageId]) {
            audioChunkBuffer[messageId] = {
                data: [],
                received: 0,
                totalChunks: totalChunks,
                ready: false
            };
        }
        
        // Ajouter ce morceau au buffer
        audioChunkBuffer[messageId].data.push({
            index: chunkIndex,
            data: decryptedData
        });
        
        audioChunkBuffer[messageId].received++;
        
        // Si tous les morceaux ont été reçus, marquer comme prêt
        if (audioChunkBuffer[messageId].received === totalChunks) {
            console.log(`Tous les morceaux reçus pour le message audio ${messageId}`);
            audioChunkBuffer[messageId].ready = true;
            
            // Traiter et afficher le message audio complet
            processAudioChunks(messageId, senderName);
        }
        
    } catch (error) {
        console.error("Erreur lors du traitement d'un morceau audio:", error);
    }
});