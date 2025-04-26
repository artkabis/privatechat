// Correction: Assurer que io() est bien défini (via le script /socket.io/socket.io.js)
const socket = io({
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
});

// Éléments DOM (vérifier existence avant utilisation dans les fonctions)
const userDetailsDiv = document.getElementById('user-details');
const nameInput = document.getElementById('name');
const joinButton = document.getElementById('join-button');
const statusDiv = document.getElementById('status');
const validationPromptDiv = document.getElementById('validation-prompt');
const validationText = document.getElementById('validation-text');
const acceptButton = document.getElementById('accept-button');
const rejectButton = document.getElementById('reject-button');
const chatAreaDiv = document.getElementById('chat-area');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const securityInfoDiv = document.getElementById('security-info');
const myFingerprintSpan = document.getElementById('my-fingerprint');
const peerFingerprintSpan = document.getElementById('peer-fingerprint');
const peerNameFingerprintSpan = document.getElementById('peer-name-fingerprint');

// Nouveaux éléments DOM pour le chat vocal
const audioControlsDiv = document.getElementById('audio-controls');
const recordButton = document.getElementById('record-button');
const stopRecordButton = document.getElementById('stop-record-button');
const audioStatus = document.getElementById('audio-status');

// État du client
let myName = '';
let myKeyPair = null; // { publicKey: CryptoKey, privateKey: CryptoKey }
let myPublicKeyJwk = null; // JWK de notre clé publique (pour export/empreinte)
let peerPublicKey = null; // CryptoKey publique du pair
let peerPublicKeyJwk = null; // JWK publique du pair (pour empreinte)
let peerName = '';
let peerId = '';
let roomId = ''; // Sera défini dans window.onload si URL valide
let validationPendingData = null; // Stocke { joiningUser: { id, name, publicKey } }

// Variables pour l'enregistrement audio
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let audioBlob = null;
let audioContext = null;
const MAX_AUDIO_SIZE = 1024 * 1024 * 5; // 5MB max pour les messages audio
const MAX_RECORDING_TIME = 15000; // 15 secondes max
const CHUNK_SIZE = 200 * 1024; // 200KB par fragment pour une transmission plus fiable
let recordingTimeout = null; // Timeout pour limiter la durée d'enregistrement

// Variables pour la réception de morceaux audio
let audioChunkBuffer = {}; // Structure pour stocker les morceaux audio par messageId

// Sons de notification (variables globales)
let notificationSounds = {
    userJoin: null,
    message: null,
    audioMessage: null
};
// Variables pour la notification du titre
let originalTitle = document.title;
let titleInterval = null;
let unreadMessages = 0;

// Fonction pour démarrer l'animation du titre
function startTitleNotification() {
    // Ne rien faire si la page est active
    if (document.visibilityState === 'visible'){
        stopTitleNotification();
        return;
    } 
    
    // Incrémenter le compteur de messages non lus
    unreadMessages++;
    
    // Arrêter l'intervalle existant s'il y en a un
    if (titleInterval) clearInterval(titleInterval);
    
    // Créer une nouvelle animation de titre
    let isOriginal = false;
    titleInterval = setInterval(() => {
        document.title = isOriginal ? originalTitle : `(${unreadMessages}) Nouveau message`;
        isOriginal = !isOriginal;
    }, 1000);
}

// Fonction pour arrêter l'animation du titre
function stopTitleNotification() {
    if (titleInterval) {
        clearInterval(titleInterval);
        titleInterval = null;
    }
    document.title = originalTitle;
    unreadMessages = 0;
}

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

// --- FONCTIONS CRYPTO (Avec gestion erreurs basique) ---

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
        updateStatus("Erreur: Impossible de générer les clés cryptographiques. Vérifiez la console.", true);
        throw error;
    }
}

async function exportPublicKey(key) {
    if (!key) return null;
    try {
        return await window.crypto.subtle.exportKey("jwk", key);
    } catch (error) {
        console.error("Erreur exportation clé publique:", error);
        updateStatus("Erreur interne lors de la préparation de la clé.", true);
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
        updateStatus("Erreur: Impossible d'utiliser la clé publique reçue. Com. chiffrée impossible.", true);
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
        updateStatus("Erreur: Impossible de chiffrer le message.", true);
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
        updateStatus("Erreur: Impossible de chiffrer le message audio.", true);
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
// --- LOGIQUE UI ET SOCKET.IO ---

function updateStatus(message, isError = false) {
    if (statusDiv) { // Vérifier si l'élément existe
        statusDiv.textContent = message;
        statusDiv.style.color = isError ? 'red' : 'black';
    }
    if (isError) console.error("Status Error:", message); else console.log("Status:", message);
}

function updateAudioStatus(message, isError = false) {
    if (audioStatus) {
        audioStatus.textContent = message;
        audioStatus.style.color = isError ? 'red' : 'green';
    }
}
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

// Ajouter un contrôle pour activer/désactiver les sons
function initSoundControls() {
    // Créer l'élément de contrôle des sons s'il n'existe pas déjà
    if (!document.getElementById('sound-control')) {
        const soundControl = document.createElement('div');
        soundControl.id = 'sound-control';
        soundControl.className = 'sound-control';
        
        // Vérifier si les sons sont activés
        const soundsEnabled = localStorage.getItem('soundNotificationsEnabled') !== 'false';
        
        // Créer le label et la checkbox
        const label = document.createElement('label');
        label.innerHTML = `
            <input type="checkbox" id="sound-toggle" ${soundsEnabled ? 'checked' : ''}>
            <span>Notifications sonores</span>
        `;
        
        soundControl.appendChild(label);
        
        // Ajouter le contrôle au document
        const chatArea = document.getElementById('chat-area');
        if (chatArea) {
            chatArea.insertBefore(soundControl, chatArea.firstChild);
        }
        
        // Ajouter l'écouteur d'événement
        const soundToggle = document.getElementById('sound-toggle');
        if (soundToggle) {
            soundToggle.addEventListener('change', function() {
                localStorage.setItem('soundNotificationsEnabled', this.checked ? 'true' : 'false');
                console.log(`Notifications sonores ${this.checked ? 'activées' : 'désactivées'}`);
            });
        }
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
    label.textContent = sender === 'me' ? `${myName} (vous) [Message Audio]` : 
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

// Fonction pour obtenir RoomID - vérifie le format
function getRoomIdFromUrl() {
    const path = window.location.pathname;
    console.log(">>> getRoomIdFromUrl: Path is:", path); // Log de débogage
    const parts = path.split('/');
    if (parts.length === 3 && parts[1] === 'chat') {
        const potentialRoomId = parts[2];
        if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(potentialRoomId)) {
            return potentialRoomId;
        } else {
            console.warn("Format d'ID dans l'URL (/chat/...) invalide:", potentialRoomId);
            return null;
        }
    }
    return null;
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
    // Démarrer l'animation du titre si la page n'est pas visible
    if (document.visibilityState !== 'visible') {
        startTitleNotification();
    }
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
    // Ajouter une notification visuelle
    addVisualNotification(messagesDiv);
    // Ajouter à la fin, après l'ajout du message à l'interface:
    playNotificationSound('audioMessage');
    
    // Nettoyer
    delete audioChunkBuffer[messageId];
}
// Réinitialise l'état et l'UI pour une nouvelle session/déconnexion sur la page CHAT
function resetChatState() {
    console.log("Réinitialisation de l'état du chat (pour page chat).");
    myName = '';
    myKeyPair = null;
    myPublicKeyJwk = null;
    peerPublicKey = null;
    peerPublicKeyJwk = null;
    peerName = '';
    peerId = '';
    validationPendingData = null;

    if (userDetailsDiv) {
         userDetailsDiv.style.display = 'block';
         if(nameInput) nameInput.value = '';
         if(nameInput) nameInput.disabled = false;
         if(joinButton) joinButton.disabled = false;
    }
    if (chatAreaDiv) chatAreaDiv.style.display = 'none';
    if (messagesDiv) messagesDiv.innerHTML = '';
    if (messageInput) { messageInput.value = ''; messageInput.disabled = true; }
    if (sendButton) sendButton.disabled = true;
    if (validationPromptDiv) validationPromptDiv.style.display = 'none';
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

// *********************************************************
// * Fonction exécutée au chargement complet de la page   *
// *********************************************************
window.onload = () => {
    console.log("Page loaded. Checking URL Pathname:", window.location.pathname);
    roomId = getRoomIdFromUrl(); // Tente de récupérer l'ID depuis l'URL

    // --- VÉRIFICATION : Sommes-nous sur une page de chat valide ? ---
    if (!roomId) {
        // NON -> Pas d'ID valide trouvé dans l'URL.
        console.warn("Aucun ID de salon valide trouvé dans l'URL. Initialisation du chat spécifique annulée.");
        updateStatus("Page d'accueil ou URL invalide pour le chat.", false);
        if (userDetailsDiv) userDetailsDiv.style.display = 'none';
        if (chatAreaDiv) chatAreaDiv.style.display = 'none';
        if (validationPromptDiv) validationPromptDiv.style.display = 'none';
        if (audioControlsDiv) audioControlsDiv.style.display = 'none';
        return; // <<< STOPPE L'EXECUTION DE window.onload ICI
    }
    // --- Fin de la vérification ---

    // OUI -> Si on arrive ici, roomId contient un UUID valide.
    console.log(`ID de salon valide trouvé: ${roomId}. Initialisation du chat...`);

    // Vérifier Web Crypto API
    if (!window.crypto || !window.crypto.subtle) {
        updateStatus("Erreur: Votre navigateur ne supporte pas l'API Web Crypto nécessaire.", true);
        if (userDetailsDiv) userDetailsDiv.style.display = 'none';
        return;
    }

    
    // Charger les sons de notification
    loadNotificationSounds();
    // Initialisation normale pour la page de chat
    console.log(`Prêt à rejoindre le salon : ${roomId}`);
    resetChatState(); // Prépare l'UI pour entrer le nom
    updateStatus("Entrez votre nom pour rejoindre ou démarrer.");
};
// *********************************************************
// * Fin de window.onload                                 *
// *********************************************************
// --- GESTION DES ÉVÉNEMENTS ---

if (joinButton) {
    joinButton.addEventListener('click', async () => {
        if (!roomId) { updateStatus("Impossible de rejoindre: ID de salon non défini.", true); return; }
        myName = nameInput.value.trim();
        if (!myName) { updateStatus("Veuillez entrer votre nom.", true); return; }

        updateStatus("Génération des clés...");
        joinButton.disabled = true;
        nameInput.disabled = true;

        try {
            myKeyPair = await generateKeyPair();
            myPublicKeyJwk = await exportPublicKey(myKeyPair.publicKey);
            if (!myPublicKeyJwk) throw new Error("Impossible d'exporter la clé publique.");
            await updateSecurityInfo(myPublicKeyJwk, null, null);

            updateStatus("Connexion et envoi de la clé...");
            socket.emit('joinRoom', { roomId: roomId, name: myName, publicKey: myPublicKeyJwk });

        } catch (error) {
            updateStatus(`Échec initialisation: ${error.message}. Réessayez.`, true);
            if (roomId && userDetailsDiv && nameInput && joinButton) {
                nameInput.disabled = false;
                joinButton.disabled = false;
            }
            myKeyPair = null; myPublicKeyJwk = null;
            await updateSecurityInfo(null, null, null);
        }
    });
}

if (sendButton && messageInput) {
    sendButton.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
}

// Événements pour l'enregistrement audio
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
        addMessage(`${myName} (vous): ${messageText}`, 'me');
        messageInput.value = '';
        updateStatus("Prêt.");
    } else {
        updateStatus("Erreur de chiffrement, message non envoyé.", true);
    }
    if(peerPublicKey) { messageInput.disabled = false; sendButton.disabled = false; messageInput.focus(); }
}

if (acceptButton && rejectButton) {
    acceptButton.addEventListener('click', async () => {
        if (!validationPendingData) return;
        acceptButton.disabled = true; rejectButton.disabled = true;
        const { joiningUser } = validationPendingData;
        updateStatus(`Acceptation de ${joiningUser.name}...`);
        if (!myPublicKeyJwk) { 
            updateStatus("Erreur: Clé locale manquante.", true);
            return;
        }
        socket.emit('acceptUser', { joiningUserId: joiningUser.id, initiatorPublicKey: myPublicKeyJwk });
        peerId = joiningUser.id; peerName = joiningUser.name; peerPublicKeyJwk = joiningUser.publicKey;
        peerPublicKey = await importPublicKey(peerPublicKeyJwk);
        if(peerPublicKey){
            updateStatus(`Connecté avec ${peerName}. Vérifiez les empreintes !`);
            addMessage(`${peerName} a rejoint le chat. N'oubliez pas de vérifier les empreintes.`, 'system');
            await updateSecurityInfo(myPublicKeyJwk, peerPublicKeyJwk, peerName);
            if(chatAreaDiv) chatAreaDiv.style.display = 'block';
            if(messageInput) messageInput.disabled = false; 
            if(sendButton) sendButton.disabled = false; 
            if(messageInput) messageInput.focus();
            if(audioControlsDiv) audioControlsDiv.style.display = 'block';
        } else {
            updateStatus(`Erreur clé ${joiningUser.name}. Chat impossible.`, true);
            if(roomId) resetChatState();
        }
        if(validationPromptDiv) validationPromptDiv.style.display = 'none';
        validationPendingData = null;
    });
}

if (rejectButton && acceptButton) {
    rejectButton.addEventListener('click', () => {
        if (!validationPendingData) return;
        acceptButton.disabled = true; rejectButton.disabled = true;
        const { joiningUser } = validationPendingData;
        updateStatus(`Refus de ${joiningUser.name}...`);
        socket.emit('rejectUser', { joiningUserId: joiningUser.id });
        if(validationPromptDiv) validationPromptDiv.style.display = 'none';
        validationPendingData = null;
    });
}


// --- ÉCOUTEURS D'ÉVÉNEMENTS SOCKET.IO ---

// Nouvel événement pour recevoir un message audio
socket.on('receiveAudioMessage', async (data) => {
    if (!roomId || !myKeyPair) return;
    if (!data?.senderName || !data.encryptedAudio || !data.encryptedKey || !data.iv) {
        console.warn("Message audio reçu invalide:", data);
        return;
    }
    
    console.log(`Message audio chiffré reçu de ${data.senderName}`);
    updateStatus(`Réception d'un message audio de ${data.senderName}...`);
    
    try {
        // Déchiffrer les données audio
        const decryptedData = await decryptBinaryData(data.encryptedAudio, data.encryptedKey, data.iv);
        
        if (!decryptedData) {
            addMessage(`[Impossible de déchiffrer le message audio de ${data.senderName}]`, 'system');
            return;
        }
        
        // Créer un blob à partir des données déchiffrées
        const audioBlob = new Blob([decryptedData], { type: 'audio/webm' });
        
        // Ajouter le message audio à l'interface
        addAudioMessage(audioBlob, 'other');
        updateStatus("Prêt.");
        // Après que le message soit déchiffré et ajouté à l'interface:
        playNotificationSound('audioMessage');
        
    } catch (error) {
        console.error("Erreur lors du déchiffrement du message audio:", error);
        addMessage(`[Erreur lors du traitement du message audio de ${data.senderName}]`, 'system');
    }
});
socket.on('receiveAudioChunk', async (data) => {
    if (!roomId || !myKeyPair) return;
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

socket.on('connect', () => { 
    console.log(`Connecté au serveur: ${socket.id}`); 
});

socket.on('connect_error', (err) => { 
    console.error('Échec connexion:', err.message); 
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

socket.on('waitingForPeer', () => { 
    if (!roomId) return; 
    updateStatus("Connecté. Attente de l'autre participant..."); 
    if(userDetailsDiv) userDetailsDiv.style.display = 'none'; 
});

socket.on('waitingForValidation', () => { 
    if (!roomId) return; 
    updateStatus("Connecté. Attente validation hôte..."); 
    if(userDetailsDiv) userDetailsDiv.style.display = 'none'; 
});

socket.on('validationRequest', (data) => {
    if (!roomId || !myKeyPair) return; 
    console.log("Demande validation reçue:", data);
    if (!data?.joiningUser?.name || !data.joiningUser.publicKey || !data.joiningUser.id) { 
        console.error("Données invalides."); 
        return; 
    }
    validationPendingData = data;
    if(validationText) validationText.textContent = `${data.joiningUser.name} souhaite rejoindre. Accepter ?`;
    if(validationPromptDiv) validationPromptDiv.style.display = 'block';
    if(acceptButton) acceptButton.disabled = false; 
    if(rejectButton) rejectButton.disabled = false;
    updateStatus("Action requise : Valider ou refuser.");
});

socket.on('joinAccepted', async (data) => {
    if (!roomId) return; 
    console.log("Accepté salon ! Hôte:", data.initiatorName);
    if (!data.initiatorPublicKey || !data.initiatorName || !data.initiatorId) { 
        updateStatus("Données reçues incomplètes. Impossible de continuer.", true);
        return; 
    }
    updateStatus(`Connecté avec ${data.initiatorName}. Vérifiez empreintes !`); 
    if(userDetailsDiv) userDetailsDiv.style.display = 'none';
    peerId = data.initiatorId; 
    peerName = data.initiatorName; 
    peerPublicKeyJwk = data.initiatorPublicKey;
    peerPublicKey = await importPublicKey(peerPublicKeyJwk);
    if (!peerPublicKey) { 
        updateStatus(`Erreur clé ${peerName}. Chat impossible.`, true); 
        if(roomId) resetChatState(); 
    } else {
        addMessage(`Rejoint chat avec ${peerName}. Vérifiez empreintes.`, 'system');
        await updateSecurityInfo(myPublicKeyJwk, peerPublicKeyJwk, peerName);
        if(chatAreaDiv) chatAreaDiv.style.display = 'block';
        if(messageInput) messageInput.disabled = false; 
        if(sendButton) sendButton.disabled = false; 
        if(messageInput) messageInput.focus();
        if(audioControlsDiv) audioControlsDiv.style.display = 'block';
        playNotificationSound('userJoin');
        // Initialiser les contrôles de son après l'établissement de la connexion
        initSoundControls();
    }
});

socket.on('peerJoined', async (data) => {
    if (!roomId || !myKeyPair) return; 
    console.log(`${data.peerName} a rejoint.`);
    if (!data.peerPublicKey || !data.peerName || !data.peerId) { 
        updateStatus("Données de pair incomplètes.", true);
        return; 
    }
    peerId = data.peerId; 
    peerName = data.peerName; 
    peerPublicKeyJwk = data.peerPublicKey;
    peerPublicKey = await importPublicKey(peerPublicKeyJwk);
    if(peerPublicKey) {
        updateStatus(`Connecté avec ${peerName}. Vérifiez empreintes !`);
        await updateSecurityInfo(myPublicKeyJwk, peerPublicKeyJwk, peerName);
        if(chatAreaDiv) chatAreaDiv.style.display = 'block'; 
        if(messageInput) messageInput.disabled = false; 
        if(sendButton) sendButton.disabled = false;
        if(audioControlsDiv) audioControlsDiv.style.display = 'block';
        // Notification visuelle sur toute la zone de chat
        addVisualNotification(chatAreaDiv);
        playNotificationSound('userJoin');
    } else { 
        updateStatus(`Erreur clé ${peerName}. Chat bloqué.`, true); 
        if(messageInput) messageInput.disabled = true; 
        if(sendButton) sendButton.disabled = true;
        if(audioControlsDiv) audioControlsDiv.style.display = 'none';
    }
});

socket.on('userRejected', (data) => { 
    if (!roomId) return; 
    updateStatus(`${data.name || 'Utilisateur'} refusé.`); 
    if(validationPromptDiv) validationPromptDiv.style.display = 'none'; 
    validationPendingData = null; 
});

socket.on('joinRejected', (data) => { 
    if (!roomId) return; 
    updateStatus(`Échec: ${data.message || 'Demande refusée.'}`, true); 
    resetChatState(); 
});

socket.on('pendingUserDisconnected', (data) => { 
    if (validationPendingData?.joiningUser.id === data.userId) { 
        updateStatus(`${data.name || 'Utilisateur attente'} déconnecté.`); 
        if(validationPromptDiv) validationPromptDiv.style.display = 'none'; 
        validationPendingData = null; 
    }
});

socket.on('receiveMessage', async (data) => {
    // Démarrer l'animation du titre si la page n'est pas visible
    if (document.visibilityState !== 'visible') {
        startTitleNotification();
    }
    if (!roomId || !myKeyPair) return; 
    if (!data?.senderName || !data.encryptedMessage) { 
        console.warn("Msg reçu invalide:", data); 
        return; 
    }
    console.log(`Msg chiffré reçu de ${data.senderName}`);
    const decryptedText = await decryptMessage(data.encryptedMessage);
    if (decryptedText === null) 
        addMessage(`[Impossible déchiffrer msg de ${data.senderName}]`, 'system');
    else 
        addMessage(`${data.senderName}: ${decryptedText}`, 'other');
        // Ajouter une notification visuelle au conteneur de messages
        addVisualNotification(messagesDiv);
        // Après que le message soit déchiffré et ajouté à l'interface:
        playNotificationSound('message');
});

socket.on('userLeft', (data) => {
    if (!roomId) return;
    if (data.userId === peerId) {
        addMessage(`${data.name || 'Correspondant'} a quitté.`, 'system'); 
        updateStatus(`Déconnecté de ${data.name || 'correspondant'}. Chat terminé.`, true);
        if(messageInput) messageInput.disabled = true; 
        if(sendButton) sendButton.disabled = true; 
        if(securityInfoDiv) securityInfoDiv.style.display = 'none';
        if(audioControlsDiv) audioControlsDiv.style.display = 'none';
        
        // Arrêter l'enregistrement s'il est en cours
        if(isRecording && mediaRecorder) {
            try {
                mediaRecorder.stop();
                isRecording = false;
            } catch (e) {
                console.error("Erreur lors de l'arrêt de l'enregistrement:", e);
            }
        }
        
        peerPublicKey = null; 
        peerPublicKeyJwk = null; 
        peerId = ''; 
        peerName = '';
    } else {
        addMessage(`${data.name} (ID: ${data.userId}) a quitté.`, 'system');
    }
});

socket.on('hostLeft', () => {
    if (!roomId) return; 
    addMessage("Hôte a quitté. Chat terminé.", 'system'); 
    updateStatus("Hôte a quitté. Chat terminé.", true);
    if(messageInput) messageInput.disabled = true; 
    if(sendButton) sendButton.disabled = true; 
    if(securityInfoDiv) securityInfoDiv.style.display = 'none';
    if(audioControlsDiv) audioControlsDiv.style.display = 'none';
    
    // Arrêter l'enregistrement s'il est en cours
    if(isRecording && mediaRecorder) {
        try {
            mediaRecorder.stop();
            isRecording = false;
        } catch (e) {
            console.error("Erreur lors de l'arrêt de l'enregistrement:", e);
        }
    }
    
    peerPublicKey = null; 
    peerPublicKeyJwk = null; 
    peerId = ''; 
    peerName = '';
});

socket.on('roomFull', () => { 
    if (!roomId) return; 
    updateStatus("Échec: Salon complet.", true); 
    resetChatState(); 
});

socket.on('errorJoining', (data) => { 
    if (!roomId && window.location.pathname.startsWith('/chat/')) 
        updateStatus(`Erreur join: ${data.message || 'Inconnue.'}`, true); 
    else if (roomId) { 
        updateStatus(`Erreur join: ${data.message || 'Inconnue.'}`, true); 
        resetChatState(); 
    }
});

socket.on('operationFailed', (data) => { 
    if (!roomId) return; 
    updateStatus(`Opération échouée: ${data.message || 'Erreur serveur.'}`, true); 
});