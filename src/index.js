import express from 'express';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import walletRoutes from './routes/wallet.js';
import paymentRoutes from './routes/payment.js';
import conductorRoutes from './routes/conductor.js';

dotenv.config();

const app = express();
app.use(express.json());

app.use('/conductor', conductorRoutes);
app.use('/auth', authRoutes);
app.use('/wallet', walletRoutes);
app.use('/payment', paymentRoutes);

app.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});