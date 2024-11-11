import { Client, GatewayIntentBits, Events, REST, Routes } from "discord.js";
import type {
  Interaction,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import { entersState } from "@discordjs/voice";
import {
  joinVoiceChannel,
  createAudioPlayer,
  VoiceConnectionStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import { opus } from "prism-media";
import { pipeline } from "node:stream";
import { createWriteStream } from "node:fs";
import OpenAI from "openai";
import fs from "node:fs";

import dotenv from "dotenv";
dotenv.config();

// Add after imports
interface TranscriptionEntry {
  timestamp: number;
  userId: string;
  username: string;
  text: string;
}

// Add these constants at the top of the file after imports
const RECORDINGS_DIR = "./recordings";
const TRANSCRIPTS_DIR = "./transcripts";
const AUDIO_DIR = "./audio";

// Helper function for WAV header generation
function getWavHeader(
  audioLength: number,
  sampleRate: number = 16000,
  channelCount: number = 1,
  bitsPerSample: number = 16
): Buffer {
  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + audioLength, 4);
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(channelCount, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE((sampleRate * bitsPerSample * channelCount) / 8, 28);
  wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(audioLength, 40);
  return wavHeader;
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Add this after client initialization
let currentTranscriptions: TranscriptionEntry[] = [];

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Define slash commands
const commands = [
  {
    name: "join",
    description: "Join a voice channel and start transcribing",
    type: 1,
  },
  {
    name: "leave",
    description: "Leave the voice channel",
    type: 1,
  },
];

// Modify the directory creation after imports
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR);
}
if (!fs.existsSync(TRANSCRIPTS_DIR)) {
  fs.mkdirSync(TRANSCRIPTS_DIR);
}
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR);
}

// Register slash commands when bot is ready
client.once(Events.ClientReady, async () => {
  console.log("Bot is ready!");

  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN!);
    console.log("Started refreshing application (/) commands.");

    await rest.put(Routes.applicationCommands(client.user!.id), {
      body: commands,
    });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "join":
      await handleJoinCommand(interaction);
      break;
    case "leave":
      await handleLeaveCommand(interaction);
      break;
  }
});

async function handleJoinCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const member = interaction.member;
  if (!member || !("voice" in member)) {
    await interaction.editReply("You need to be in a voice channel!");
    return;
  }

  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    await interaction.editReply("You need to be in a voice channel!");
    return;
  }

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
    });

    // Create audio player for responses
    const audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });
    connection.subscribe(audioPlayer);

    // Handle speaking events
    connection.receiver.speaking.on("start", async (userId: string) => {
      console.log(`User ${userId} started speaking`);
      const timestamp = Date.now();

      // Get the username
      const user = await client.users.fetch(userId);
      const username = user.username;
      console.log(`Username: ${username}`);

      const audioStream = connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 100,
        },
      });

      const opusDecoder = new opus.Decoder({
        rate: 16000,
        channels: 1,
        frameSize: 960,
      });

      const pcmFileName = `${AUDIO_DIR}/${userId}-${timestamp}.pcm`;
      const wavFileName = `${AUDIO_DIR}/${userId}-${timestamp}.wav`;
      const writeStream = createWriteStream(pcmFileName);

      pipeline(audioStream, opusDecoder, writeStream, async (err) => {
        if (err) {
          console.error("Error in audio pipeline:", err);
          return;
        }

        try {
          // Wait a bit for the file to be fully written
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Convert PCM to WAV
          const pcmBuffer = fs.readFileSync(pcmFileName);
          const wavHeader = getWavHeader(pcmBuffer.length);
          const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
          fs.writeFileSync(wavFileName, wavBuffer);

          // Transcribe the audio
          const transcription = await transcribeAudio(wavFileName);
          if (transcription && transcription.trim()) {
            // Add transcription to the current session with username
            currentTranscriptions.push({
              timestamp,
              userId,
              username,
              text: transcription.trim(),
            });

            // Save individual transcription with username
            const individualTranscriptFile = `${TRANSCRIPTS_DIR}/transcript-${username}-${timestamp}.txt`;
            fs.writeFileSync(
              individualTranscriptFile,
              `Time: ${new Date(
                timestamp
              ).toISOString()}\nUser: ${username}\nTranscription: ${transcription.trim()}\n`
            );
          }

          // Cleanup PCM file
          fs.unlinkSync(pcmFileName);
        } catch (error) {
          console.error("Error processing audio:", error);
        }
      });
    });

    // Handle connection state changes
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (error) {
        connection.destroy();
      }
    });

    await interaction.editReply(
      "Joined the voice channel and started listening!"
    );
  } catch (error) {
    console.error(error);
    await interaction.editReply("Failed to join the voice channel!");
  }
}

async function handleLeaveCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply("This command can only be used in a server!");
    return;
  }

  const member = interaction.member as GuildMember;
  if (!member.voice?.channel) {
    await interaction.editReply(
      "You need to be in a voice channel to use this command!"
    );
    return;
  }

  try {
    if (currentTranscriptions.length > 0) {
      const timestamp = Date.now();
      const sessionDate = new Date(timestamp).toISOString().split("T")[0];

      // Sort transcriptions by timestamp
      currentTranscriptions.sort((a, b) => a.timestamp - b.timestamp);

      // Create a more detailed transcript with usernames
      const fullTranscript = currentTranscriptions
        .map((t) => {
          const time = new Date(t.timestamp).toISOString();
          return `[${time}] ${t.username}: ${t.text}`;
        })
        .join("\n");

      // Save consolidated transcript
      const consolidatedFileName = `${TRANSCRIPTS_DIR}/session-${sessionDate}-${timestamp}.txt`;
      fs.writeFileSync(
        consolidatedFileName,
        `Session Transcript\nDate: ${sessionDate}\n\n${fullTranscript}\n`
      );

      // Get summary using all transcriptions
      const summary = await summarizeText(fullTranscript);

      // Save summary to the consolidated file
      fs.appendFileSync(consolidatedFileName, `\n\nSummary:\n${summary}\n`);

      // Read all individual transcript files for this session
      const transcriptFiles = fs
        .readdirSync(TRANSCRIPTS_DIR)
        .filter((file) => file.startsWith("transcript-"))
        .filter((file) => {
          const fileTimestamp = parseInt(
            file.split("-").pop()?.split(".")[0] || "0"
          );
          // Only include files from this session (last hour to be safe)
          return timestamp - fileTimestamp < 3600000;
        });

      // Delete individual transcript files after consolidation
      for (const file of transcriptFiles) {
        fs.unlinkSync(`${TRANSCRIPTS_DIR}/${file}`);
      }

      // Send summary and transcript file to channel
      await interaction.editReply({
        content: `Session Summary:\n\n${summary}`,
        files: [
          {
            attachment: consolidatedFileName,
            name: `transcript-${sessionDate}.txt`,
            description: "Session Transcript",
          },
        ],
      });

      // Clear transcriptions for next session
      currentTranscriptions = [];
    } else {
      await interaction.editReply(
        "Left the channel. No conversations were recorded."
      );
    }

    // Destroy the connection
    const connection = joinVoiceChannel({
      channelId: member.voice.channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator as any,
    });
    connection.destroy();
  } catch (error) {
    console.error(error);
    await interaction.editReply("Failed to leave the voice channel!");
  }
}

async function transcribeAudio(filePath: string): Promise<string> {
  try {
    const file = fs.createReadStream(filePath);
    const response = await openai.audio.transcriptions.create({
      file: file,
      model: "whisper-1",
      response_format: "text",
    });
    return response;
  } catch (error) {
    console.error("Error transcribing audio:", error);
    return "";
  }
}

async function summarizeText(text: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are a professional meeting summarizer. Please analyze the following meeting transcript and create a comprehensive yet concise summary. Focus on key decisions, action items, important discussions, and main takeaways. Structure the summary in a clear, organized manner while preserving all critical technical details and ensuring no important information is lost.",
        },
        {
          role: "user",
          content: text,
        },
      ],
    });
    return response.choices[0].message.content ?? "";
  } catch (error) {
    console.error("Error summarizing text:", error);
    return "";
  }
}

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
