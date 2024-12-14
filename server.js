import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { sendEmail, createEstimateEmailTemplate} from './services/emailService.js';
import { sendWhatsAppMessage, createWhatsAppTemplate, handleIncomingWhatsAppMessage} from './services/whatsappService.js';

dotenv.config();

console.log('Environment Check:', {
  hasWhatsAppToken: !!process.env.WHATSAPP_ACCESS_TOKEN,
  whatsAppTokenLength: process.env.WHATSAPP_ACCESS_TOKEN?.length,
  whatsAppPhoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  hasElevenLabsToken: !!process.env.ELEVEN_LABS_API_KEY,
  hasVoiceId: !!process.env.ELEVEN_LABS_VOICE_ID
});

const app = express();

const ELEVEN_LABS_API_KEY = process.env.ELEVEN_LABS_API_KEY;
const ELEVEN_LABS_VOICE_ID = process.env.ELEVEN_LABS_VOICE_ID;

app.use(cors());
app.use(express.json());

let websiteContext = {};
let blockedIPs = new Map();
let offTopicCounters = new Map();


async function saveLead(leadData) {
  try {
    console.log('Starting lead save process...', leadData);

    const leadsFilePath = path.join(process.cwd(), 'leads.json');
    let leads = [];
    
    try {
      const data = await fs.readFile(leadsFilePath, 'utf8');
      leads = JSON.parse(data);
    } catch (error) {
      console.log('Starting new leads file');
      leads = [];
    }
    
    const leadWithTimestamp = {
      ...leadData,
      timestamp: new Date().toISOString()
    };
    
    leads.push(leadWithTimestamp);
    
    await fs.writeFile(leadsFilePath, JSON.stringify(leads, null, 2));
    
    // Determine email subject based on service or request type
    let emailSubject = '3alaFekra - ';
    if (leadData.service) {
      emailSubject += `${leadData.service} Service Request`;
    } else {
      emailSubject += 'Service Inquiry';
    }

    // Send confirmation email to the lead
    console.log('Attempting to send email...');
    try {
      const emailResult = await sendEmail({
        to: leadData.email,
        subject: `3alaFekra - ${leadData.service || 'Service'} Inquiry`,
        html: createEstimateEmailTemplate(leadData)
      });
      console.log('Email sent successfully:', emailResult);
      } catch (emailError) {
        console.error('Detailed email error:', emailError);
        console.error('Email configuration:', {
          host: process.env.EMAIL_HOST,
          port: process.env.EMAIL_PORT,
          user: process.env.EMAIL_USER,
          // Don't log password
        });
      }
      
      if (leadData.mobileNumber) {
        console.log('Preparing WhatsApp message for:', leadData.mobileNumber);
        try {
          const whatsappMessage = createWhatsAppTemplate(leadData);
          console.log('WhatsApp message content:', whatsappMessage);
          
          // Ensure mobile number is a string
          const mobileNumber = String(leadData.mobileNumber).trim();
          
          const whatsappResult = await sendWhatsAppMessage(
            mobileNumber,
            whatsappMessage
          );
          console.log('WhatsApp message sent successfully:', whatsappResult);
        } catch (whatsappError) {
          console.error('Error sending WhatsApp message:', whatsappError);
          console.error('WhatsApp configuration:', {
            phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
            hasToken: !!process.env.WHATSAPP_ACCESS_TOKEN,
            number: leadData.mobileNumber
          });
        }
      }
      
      console.log('Lead save process completed successfully');
      return true;
    } catch (error) {
      console.error('Critical error in saveLead:', error);
      return false;
    }
}
// Function to check message relevance
function checkMessageRelevance(message) {
  const relevantKeywords = [
    'website', 'services', 'web', 'development', 'seo', 
      'company', '3alafekra', 'business', 'contact', 'price',
      'project', 'work', 'portfolio', 'about', 'ai consultant',
      'email', 'send', 'message', 'estimate', 'quote',
      'information', 'details', 'contact', 'whatsapp'
  ];

  const lowercaseMessage = message.toLowerCase();
  
  const inappropriatePatterns = [
    'kiss', 'date', 'meet', 'relationship', 'personal',
    'inappropriate', 'private', 'chat', 'friend'
  ];

  if (inappropriatePatterns.some(pattern => lowercaseMessage.includes(pattern))) {
    return false;
  }

  return relevantKeywords.some(keyword => lowercaseMessage.includes(keyword.toLowerCase()));
}

// Function to manage off-topic counters
function manageOffTopicCounter(clientIP, isOffTopic) {
  if (!offTopicCounters.has(clientIP)) {
    offTopicCounters.set(clientIP, 0);
  }

  if (isOffTopic) {
    const currentCount = offTopicCounters.get(clientIP);
    offTopicCounters.set(clientIP, currentCount + 1);
    return currentCount + 1;
  } else {
    offTopicCounters.set(clientIP, 0);
    return 0;
  }
}

async function loadWebsiteContext() {
  try {
    const data = await fs.readFile('website_context.json', 'utf8');
    websiteContext = JSON.parse(data);
    console.log('Website context loaded successfully');
  } catch (error) {
    console.error('Error loading website context:', error);
  }
}

loadWebsiteContext();

app.use((req, res, next) => {
  console.log(`Received request: ${req.method} ${req.url}`);
  next();
});

// Amanda's profile

let amandaProfile = {
  name: 'Amanda',
  role: 'AI Website Guide',
  personality: 'Friendly, knowledgeable, funny, speak less, and focused',
  expertise: ['Web technologies', 'Sales', 'Website development', 'Email Communication'],
  greeting: "Hello! I'm Amanda, Saef's personal assistant and i am here to guide you through the website. How can I help you today?",
  capabilities: {
    emailSupport: true,
    leadCollection: true,
    navigation: true,
    whatsappSupport: true
  },
  rules: {
    maxOffTopicResponses: 3,
    offTopicMessage: "I apologize, but I've noticed we've strayed from discussing the website. Would you like to know more about our services or any specific part of our website?",
    refocusMessage: "Let's bring our conversation back to the website. Is there anything specific about our services or pages you'd like to know more about?"
  },
  navigationInstructions: "When referring to a specific page on the website, use the format [NAVIGATE:/page-url] to allow for automatic navigation."
};

// Route to get Amanda's profile
app.get('/amanda-profile', (req, res) => {
  console.log('Amanda profile route hit');
  res.json(amandaProfile);
});

// Main messages route
app.post('/v1/messages', async (req, res) => {
  const clientIP = req.ip;
  
  // Check if already blocked
  if (blockedIPs.has(clientIP)) {
    const blockTime = blockedIPs.get(clientIP);
    if (Date.now() - blockTime > 3600000) { // 1 hour
      blockedIPs.delete(clientIP);
      offTopicCounters.delete(clientIP);
    } else {
      return res.status(403).json({
        error: 'Chat access is blocked',
        block_chat: true,
        content: [{ text: "Your access is currently blocked due to multiple off-topic messages. Please try again later." }],
        navigate_to: '/blocked'
      });
    }
  }

  try {
    const userMessage = req.body.messages[req.body.messages.length - 1].content;
    const isRelatedToWebsite = checkMessageRelevance(userMessage);
    const offTopicCount = manageOffTopicCounter(clientIP, !isRelatedToWebsite);

    let systemMessage = `You are ${amandaProfile.name}, ${amandaProfile.personality}. Your expertise includes: ${amandaProfile.expertise.join(', ')}. Your role is: ${amandaProfile.role}. 
    You have access to the following website information:
    ${JSON.stringify(websiteContext)}
    
    You have the ability to send emails to users. When users request information about our services, pricing, or any documentation:
    1. Let them know you can send them detailed information via email
    2. Offer to collect their contact information
    3. Be specific about what information you'll send them

    Some key points about handling email requests:
    - If someone asks about prices or services, offer to send detailed information via email
    - If someone wants documentation or examples, mention you can email those
    - When someone asks for contact information, offer to send it via email
    - Always maintain a professional tone when discussing email communications
    - If someone asked you to contact Saef our founder tell hi that the best way to contact him is by a phone call on 01000494040
    - in the word 3alaFekra we dont say the 3 we say alafekra as the 3 is instead of "ع"

    Current website information: ${JSON.stringify(websiteContext)}

    ${amandaProfile.navigationInstructions}`;
    
    if (offTopicCount >= 3) {
      blockedIPs.set(clientIP, Date.now());
      return res.json({
        block_chat: true,
        content: [{ text: "I apologize, but we need to stay focused on website-related topics. This conversation has been blocked due to multiple off-topic messages." }],
        navigate_to: '/blocked'
      });
    } else if (offTopicCount === 2) {
      systemMessage += ` ${amandaProfile.rules.offTopicMessage}`;
    } else if (offTopicCount === 1) {
      systemMessage += " Politely redirect the conversation back to website-related topics.";
    }

    // Ensure messages are properly formatted for Anthropic API
    const messages = req.body.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));


    console.log('Forwarding request to Anthropic API');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        ...req.body,
        system: systemMessage,
        // messages: req.body.messages
        messages: messages
      })
    });

    const data = await response.json();
    res.json(data);

  } catch (error) {
    console.error('Error in /v1/messages:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/v1/leads', async (req, res) => {
  try {
    console.log('Received leads request');
    const leadsFilePath = path.join(process.cwd(), 'leads.json');
    const data = await fs.readFile(leadsFilePath, 'utf8');
    const leads = JSON.parse(data);
    console.log(`Found ${leads.length} leads`);
    res.json(leads);
  } catch (error) {
    console.error('Error reading leads:', error);
    res.status(500).json({ error: 'Failed to retrieve leads' });
  }
});

// Unblock route
app.post('/api/v1/unblock', (req, res) => {
  const clientIP = req.ip;
  console.log('Attempting to unblock IP:', clientIP);
  
  if (blockedIPs.has(clientIP)) {
    blockedIPs.delete(clientIP);
    offTopicCounters.delete(clientIP);
    console.log('Successfully unblocked IP:', clientIP);
    res.json({ 
      success: true,
      message: 'Chat has been unblocked successfully.' 
    });
  } else {
    console.log('IP was not blocked:', clientIP);
    res.json({ 
      success: true,
      message: 'Chat was not blocked.' 
    });
  }
});

// Leads
app.post('/api/v1/leads', async (req, res) => {
  console.log('Received lead data:', req.body); // Add this for debugging
  try {
    const leadData = req.body;
    
    // Validate required fields
    const requiredFields = ['name', 'email', 'companyName', 'mobileNumber', 'service'];
    const missingFields = requiredFields.filter(field => !leadData[field]);

    if (!leadData) {
      return res.status(400).json({
        error: 'No data provided'
      });
    }
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missingFields.join(', ')}`
      });
    }
    
    // Save the lead
    const success = await saveLead(leadData);
    
    if (success) {
      res.json({ success: true, message: 'Lead saved successfully' });
    } else {
      res.status(500).json({ error: 'Failed to save lead' });
    }
  } catch (error) {
    console.error('Error in leads endpoint:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/v1/leads', async (req, res) => {
  console.log('Received lead request:', req.body);
  
  try {
    const leadData = req.body;
    
    // Basic validation
    if (!leadData || Object.keys(leadData).length === 0) {
      console.log('Invalid lead data received');
      return res.status(400).json({
        error: 'Invalid lead data'
      });
    }

    // Save the lead
    const success = await saveLead(leadData);
    
    if (success) {
      console.log('Lead saved successfully');
      res.json({ 
        success: true, 
        message: 'Lead saved successfully' 
      });
    } else {
      console.log('Failed to save lead');
      res.status(500).json({ 
        error: 'Failed to save lead' 
      });
    }
  } catch (error) {
    console.error('Error processing lead:', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      details: error.message 
    });
  }
});

app.get('/test-services', async (req, res) => {
  try {
    const results = {
      email: null,
      whatsapp: null
    };

    // Test email
    try {
      const emailResult = await sendEmail({
        to: 'safago@gmail.com',  // Replace with your email
        subject: 'Test Email from 3alaFekra',
        html: 'This is a test email to verify the email service is working.'
      });
      results.email = emailResult;
    } catch (emailError) {
      results.email = { error: emailError.message };
    }

    // Test WhatsApp
    try {
      const whatsappStatus = await testWhatsAppConnection();
      results.whatsapp = whatsappStatus;
    } catch (whatsappError) {
      results.whatsapp = { error: whatsappError.message };
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test-email', async (req, res) => {
  try {
    const testResult = await testEmailService();
    res.json(testResult);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test-whatsapp', async (req, res) => {
  try {
    const result = await sendWhatsAppMessage(
      '201000494040',  // Your test number
      'Test message from 3alaFekra API test endpoint'
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add these routes to server.js
app.all('/verify-email', async (req, res) => {
  try {
    console.log('Testing email service...');
    const testEmail = 'safago@gmail.com'; // Your test email address
    const result = await sendEmail({
      to: testEmail,
      subject: '3alaFekra - Email Verification Test',
      html: `
        <h1>Email Verification Test</h1>
        <p>This is a test email sent at ${new Date().toLocaleString()}</p>
        <p>If you received this email, your email service is working correctly.</p>
      `
    });
    
    console.log('Email test result:', result);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Email test error:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.get('/verify-smtp', async (req, res) => {
  try {
    const verification = await transporter.verify();
    res.json({
      success: true,
      verified: verification,
      config: {
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT,
        user: process.env.EMAIL_USER,
        secure: true
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add these routes in server.js after your existing routes but before app.listen()

app.get('/api/check-email-config', (req, res) => {
  const config = {
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      hasPassword: !!process.env.EMAIL_APP_PASSWORD
    }
  };
  
  res.json({
    config,
    envVarsPresent: {
      EMAIL_USER: !!process.env.EMAIL_USER,
      EMAIL_APP_PASSWORD: !!process.env.EMAIL_APP_PASSWORD
    }
  });
});

app.all('/api/verify-email', async (req, res) => {
  try {
    console.log('Testing email service...');
    const testEmail = 'safago@gmail.com'; // Your test email address
    const result = await sendEmail({
      to: testEmail,
      subject: '3alaFekra - Email Verification Test',
      html: `
        <h1>Email Verification Test</h1>
        <p>This is a test email sent at ${new Date().toLocaleString()}</p>
        <p>If you received this email, your email service is working correctly.</p>
      `
    });
    
    console.log('Email test result:', result);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Email test error:', {
      message: error.message,
      code: error.code,
      commandRes: error.command
    });
    res.status(500).json({ 
      error: error.message, 
      code: error.code,
      details: error.command 
    });
  }
});

// Email monitoring endpoint
app.get('/api/v1/check-emails', async (req, res) => {
  try {
    await emailMonitor.checkNewEmails();
    res.json({ success: true, message: 'Email check completed' });
  } catch (error) {
    console.error('Error checking emails:', error);
    res.status(500).json({ error: 'Failed to check emails' });
  }
});

app.get('/api/v1/whatsapp-webhook', (req, res) => {
  try {
    console.log('Verification request received:', req.query);
    
    const mode = req.query['hub.mode'];
    const verifyToken = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && verifyToken === 'amanda3alafekra') {
      console.log('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.log('Verification failed:', { mode, verifyToken });
      res.sendStatus(403);
    }
  } catch (error) {
    console.error('Verification error:', error);
    res.sendStatus(500);
  }
});

// Webhook message handling endpoint (handles POST requests)
app.post('/api/v1/whatsapp-webhook', async (req, res) => {
  try {
    console.log('Webhook POST received:', JSON.stringify(req.body, null, 2));
    const { entry } = req.body;
    
    if (entry && entry[0].changes && entry[0].changes[0].value.messages) {
      const message = entry[0].changes[0].value.messages[0];
      await handleIncomingWhatsAppMessage({
        from: message.from,
        text: message.text.body
      });
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Failed to process WhatsApp message' });
  }
});


// Testing

// Test endpoint for WhatsApp handler
app.all('/test-whatsapp-handler', async (req, res) => {
  try {
    console.log('Test WhatsApp handler called');
    const testMessage = {
      from: '201000494040',
      text: 'can you check my email please'
    };

    const result = await handleIncomingWhatsAppMessage(testMessage);
    res.json({
      success: true,
      testMessage,
      result
    });
  } catch (error) {
    console.error('Test handler error:', error);
    res.status(500).json({ error: error.message });
  }
});


// For debugging - log all registered routes
app._router.stack.forEach(function(r){
    if (r.route && r.route.path){
        console.log(r.route.path)
    }
});

// Test sending and receiving WhatsApp message
app.all('/test-whatsapp-communication', async (req, res) => {
  try {
    console.log('Testing WhatsApp communication...');
    const testMessage = "Hello from Amanda! This is a test message.";
    const yourNumber = "201000494040"; // Your number
    
    // Send test message
    const sendResult = await sendWhatsAppMessage(yourNumber, testMessage);
    console.log('WhatsApp test message sent:', sendResult);
    
    // Test webhook handling
    const mockWebhookData = {
      entry: [{
        changes: [{
          value: {
            messages: [{
              from: "201000494040",
              text: { body: "Test reply from WhatsApp" }
            }]
          }
        }]
      }]
    };

    // Handle the mock message
    if (mockWebhookData.entry[0].changes[0].value.messages) {
      const message = mockWebhookData.entry[0].changes[0].value.messages[0];
      console.log('Received WhatsApp message:', {
        from: message.from,
        text: message.text.body
      });
    }

    res.json({
      success: true,
      sendResult,
      webhookTest: 'Message received and processed'
    });
  } catch (error) {
    console.error('WhatsApp test error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

app.all('/test-email-communication', async (req, res) => {
  try {
    console.log('Starting email test...');
    
    // Test email sending using existing service
    const testEmail = {
      to: 'saef.reyad@three60.degree',
      subject: 'Amanda Communication Test',
      html: createEstimateEmailTemplate({
        name: 'Test User',
        companyName: 'Test Company',
        mobileNumber: '1234567890',
        service: 'Email Testing'
      })
    };

    console.log('Sending test email...', {
      to: testEmail.to,
      subject: testEmail.subject
    });

    const emailResult = await sendEmail(testEmail);
    
    console.log('Email test completed:', emailResult);

    res.json({
      success: true,
      emailResult,
      message: 'Test email sent successfully'
    });

  } catch (error) {
    console.error('Email test error:', {
      name: error.name,
      message: error.message,
      code: error.code,
      command: error.command
    });
    
    res.status(500).json({ 
      error: error.message,
      details: {
        emailConfigured: !!process.env.EMAIL_USER && !!process.env.EMAIL_APP_PASSWORD,
        errorCode: error.code,
        errorCommand: error.command
      }
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});