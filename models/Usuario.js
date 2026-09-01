const mongoose = require('mongoose');

const usuarioSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    nombre: { type: String, required: true },
    strikes: { type: Number, default: 0 },
    escalon: { type: Number, default: 0 },
    referidoPor: { type: Number, default: null },
    totalReferidos: { type: Number, default: 0 },
    suscripcionActiva: { type: Boolean, default: false },
    fechaVencimiento: { type: Date, default: null },
    esVip: { type: Boolean, default: false }
});

module.exports = mongoose.model('Usuario', usuarioSchema);