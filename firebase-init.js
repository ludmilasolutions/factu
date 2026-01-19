// firebase-init.js
const firebaseConfig = {
  apiKey: "AIzaSyCtOiUy2tUQeixUiJxTdI_ESULY4WpqXzw",
  authDomain: "whatsappau-30dc1.firebaseapp.com",
  projectId: "whatsappau-30dc1",
  storageBucket: "whatsappau-30dc1.firebasestorage.app",
  messagingSenderId: "456068013185",
  appId: "1:456068013185:web:5bdd49337fb622e56f0180"
};

// Inicializar Firebase
firebase.initializeApp(firebaseConfig);

// Exportar las instancias
export const db = firebase.firestore();
export const auth = firebase.auth();

// Habilitar persistencia offline
db.enablePersistence()
  .catch((err) => {
    console.warn("Persistencia no soportada:", err.code);
  });
