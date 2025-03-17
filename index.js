const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const fetch = require("node-fetch");
const cron = require("cron");

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const BOT_TOKEN =
    "Enter your Discord bot token here"; // Bot token
const CHANNEL_IDLIVE = "Enter your Discord channel ID here"; // ID channel livestream

const allowedUsernamesIDN = ["Enter the member's display name here"]; //IDN
const allowedUsernamesShowroom = ["Enter the member's display name here"]; // SHOWROOM
const sentNotifications = new Set();
const sentCreators = new Set();
const lastLiveStartTimesIDN = new Map();
const lastLiveStartTimesShowroom = new Map();
const maxViewCountsIDN = new Map();  // Untuk IDN
const maxViewCountsShowroom = new Map();  // Untuk Showroom

const idnUrl = "https://api.idn.app/graphql";
const showroomUrl = "https://www.showroom-live.com/api/live/onlives";

const headersIDN = {
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "application/json",
    "Host": "api.idn.app",
    "Origin": "https://www.idn.app",
    "Referer": "https://www.idn.app/",
};

async function getIdnLivestreamData() {
    const allLivestreamData = [];

    for (let page = 1; page <= 8; page++) {
        const body = JSON.stringify({
            query: `
          query GetLivestream($category: String, $page: Int) {
            getLivestreams(category: $category, page: $page) {
              slug
              title
              image_url
              view_count
              playback_url
              room_identifier
              status
              scheduled_at
              live_at
              category {
                name
                slug
              }
              creator {
                name
                username
                uuid
              }
            }
          }
        `,
            variables: {
                page: page,
                category: "all",
            },
            operationName: "GetLivestream",
        });

        try {
            const response = await fetch(idnUrl, {
                method: "POST",
                headers: headersIDN,
                body: body,
            });
            if (!response.ok)
                throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();

            // Gabungkan semua data livestream dari setiap halaman
            allLivestreamData.push(...(data.data.getLivestreams || []));
        } catch (error) {
            console.error(
                `Error fetching IDN livestream data for page ${page}:`,
                error
            );
        }
    }

    return allLivestreamData;
}

// ini bagian ngambil data dari api showroom
async function getShowroomLivestreamData() {
    const headersShowroom = {
        "Accept": "*/*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Connection": "keep-alive",
    };

    try {
        const response = await fetch(showroomUrl, {
            method: "GET",
            headers: headersShowroom,
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        return (
            data.onlives
                .flatMap((category) => category.lives)
                .filter((livestream) =>
                    allowedUsernamesShowroom.includes(livestream.main_name)
                ) || []
        );
    } catch (error) {
        console.error("Error fetching Showroom livestream data:", error);
        return [];
    }
}

// untuk mengecek api backup ketika username yang di target tidak tersedia pada api utama
async function livestreamNotificationIdn() {
    const livestreamData = await getIdnLivestreamData();
    const currentCreators = new Set();

    if (livestreamData.length > 0) {
        for (const livestream of livestreamData) {
            const creatorName = livestream.creator?.name;
            currentCreators.add(creatorName);

            if (allowedUsernamesIDN.includes(creatorName)) {
                const viewCount = livestream.view_count;

                // Inisialisasi cache untuk creator jika belum ada
                if (!maxViewCountsIDN.has(creatorName)) {
                    maxViewCountsIDN.set(creatorName, new Set());
                }

                // Tambahkan view_count ke cache hanya jika belum ada (hindari duplikat)
                const creatorCache = maxViewCountsIDN.get(creatorName);
                if (!creatorCache.has(viewCount)) {
                    creatorCache.add(viewCount);

                    // Kirim notifikasi live baru jika slug belum dikirim
                    if (!sentNotifications.has(livestream.slug)) {
                        sentNotifications.add(livestream.slug);

                        await sendLivestreamNotificationIdn(livestream);
                        lastLiveStartTimesIDN.set(creatorName, {
                            startTime: livestream.live_at,
                            viewCount: viewCount.toLocaleString('id-ID')
                        });
                    }
                }
            }
        }
    }

    // Bagian untuk mengecek apakah user masih live atau tidak
    for (const [creatorName, { startTime }] of lastLiveStartTimesIDN.entries()) {
        if (!currentCreators.has(creatorName)) {
            const liveDuration = calculateDuration(startTime);

            // Ambil angka terbesar dari cache view_count creator
            const maxViewCounts = Math.max(...(maxViewCountsIDN.get(creatorName) || []), 0); // Tambahkan default 0 agar tidak error jika data kosong
            const Max = maxViewCounts.toLocaleString('id-ID');
            await sendEndLivestreamNotification(creatorName, liveDuration, Max);
            sentCreators.delete(creatorName);
        }
    }
}

async function livestreamNotificationShowroom() {
    const showroomLivestreamData = await getShowroomLivestreamData();
    const currentCreators = new Set();

    if (showroomLivestreamData.length > 0) {
        for (const livestream of showroomLivestreamData) {
            const creatorName = livestream.main_name;
            currentCreators.add(creatorName);

            if (
                allowedUsernamesShowroom.includes(creatorName) &&
                !sentNotifications.has(livestream.room_url_key)
            ) {
                sentNotifications.add(livestream.room_url_key);
                const viewCount = livestream.view_num;

                // Inisialisasi cache untuk creator jika belum ada
                if (!maxViewCountsShowroom.has(creatorName)) {
                    maxViewCountsShowroom.set(creatorName, []);
                }
                const creatorCache = maxViewCountsShowroom.get(creatorName);
                creatorCache.push(viewCount);
                console.log(`[DEBUG] ${creatorName} - View Sekarang: ${viewCount} - Max Tersimpan: ${Math.max(...maxViewCountsShowroom.get(creatorName) || [0])}`);

                // Kirim notifikasi live baru
                await sendLivestreamNotificationShowroom(livestream);
            }
        }
    }

    // Bagian untuk mengecek apakah user masih live atau tidak
    for (const [creatorName, { startTime }] of lastLiveStartTimesShowroom.entries()) {
        if (!currentCreators.has(creatorName)) {
            const liveDuration = calculateDuration(startTime);

            // Ambil angka terbesar dari cache view_count creator
            const maxViewCount = Math.max(...(maxViewCountsShowroom.get(creatorName) || [0])); // tambahkan default 0 agar tidak error jika data kosong
            const Max = maxViewCount.toLocaleString('id-ID');
            console.log(`[END LIVE DEBUG] ${creatorName} - Max View Final: ${maxViewCount}`);

            await sendEndLivestreamNotificationShowroom(creatorName, liveDuration, Max);
            sentCreators.delete(creatorName);
        }
    }
}


// nah bagian ini untuk meng satset kalau username tidak di temukan padahal sebelumnya ada (idn)
async function sendEndLivestreamNotification(creatorName, duration, Max) {
    try {
        const channel = await client.channels.fetch(CHANNEL_IDLIVE);
        await channel.send(
            `🔴 Siaran langsung oleh ${creatorName} sudah berakhir.\nTotal View: ${Max}.\nDurasi siaran: ${duration.hours} jam, ${duration.minutes} menit, ${duration.seconds} detik.`
        );

        maxViewCountsIDN.delete(creatorName);
        lastLiveStartTimesIDN.delete(creatorName);

        sentNotifications.forEach((slug) => {
            if (slug.includes(creatorName)) {
                sentNotifications.delete(slug);
            }
        });
    } catch (error) {
        console.error("Error sending end livestream message to Discord:", error);
    }
}

async function sendEndLivestreamNotificationShowroom(creatorName, duration, Max) {
    try {
        const channel = await client.channels.fetch(CHANNEL_IDLIVE);
        await channel.send(
            `🔴 Siaran langsung oleh ${creatorName} sudah berakhir.\nTotal View: ${Max}.\nDurasi siaran: ${duration.hours} jam, ${duration.minutes} menit, ${duration.seconds} detik.`
        );

        maxViewCountsShowroom.delete(creatorName);
        lastLiveStartTimesShowroom.delete(creatorName);

        sentNotifications.forEach((roomUrlKey) => {
            if (roomUrlKey.includes(creatorName)) {
                sentNotifications.delete(roomUrlKey);
            }
        });
    } catch (error) {
        console.error("Error sending end livestream message to Discord:", error);
    }
}

// ini bagian mengirim pesan pada bagian idn
async function sendLivestreamNotificationIdn(livestream) {
    const title = livestream.title || "No Title";
    const creatorName = livestream.creator?.name || "Unknown";
    const startTimeWIB = convertToWIB(livestream.live_at);
    const gambar = livestream.image_url;

    const embed = new EmbedBuilder()
        .setTitle(`🔔 ${creatorName} Sedang Live di IDN!`)
        .setDescription(`Ayo nonton sekarang! 🎥\n**Judul:** \n${title}\n**Mulai (WIB):** \n${startTimeWIB}`)
        .setColor("#FBEC5D")
        .setImage(gambar);

    const buttonChannel = new ButtonBuilder()
        .setLabel("IDN WEBSITE") // Tombol dengan channel URL asli
        .setStyle(ButtonStyle.Link)
        .setURL(channelUrl);

    const row = new ActionRowBuilder().addComponents(buttonShortLink, buttonChannel);

    try {
        const channel = await client.channels.fetch(CHANNEL_IDLIVE);
        await channel.send({
            content: `Halo @everyone, ${creatorName} sedang live nih!`,
            embeds: [embed],
            components: [row],
        });
    } catch (error) {
        console.error("Error sending message to Discord:", error);
    }
}

// ini bagian mengirim pesan pada bagian Showroom
async function sendLivestreamNotificationShowroom(livestream) {
    const title = livestream.telop || "JKT48";
    const creatorName = livestream.main_name || "Unknown";
    const startTimeWIB = convertToWIB(livestream.started_at);
    const gambar = livestream.image_square;
    const channelUrl = `https://www.showroom-live.com/r/${livestream.room_url_key}`;

    const embed = new EmbedBuilder()
        .setTitle(`🔔 ${creatorName} Sedang Live di Showroom!`)
        .setDescription(
            `Ayo nonton sekarang! 🎥\n**Judul:** \n${title}\n**Mulai (WIB):** \n${startTimeWIB}`
        )
        .setColor("#FBEC5D")
        .setImage(gambar);

    const button = new ButtonBuilder()
        .setLabel("Showroom WEB & APP")
        .setStyle(ButtonStyle.Link)
        .setURL(channelUrl);

    const row = new ActionRowBuilder().addComponents(button);

    try {
        const channel = await client.channels.fetch(CHANNEL_IDLIVE);
        await channel.send({
            content: `Halo @everyone, ${creatorName} sedang live nih di Showroom!`,
            embeds: [embed],
            components: [row],
        });
    } catch (error) {
        console.error("Error sending message to Discord:", error);
    }
}

function calculateDuration(startTime) {
    let start;

    // Deteksi format startTime
    if (typeof startTime === "string") {
        start = new Date(startTime); // ISO 8601, langsung konversi
    } else if (typeof startTime === "number") {
        start = new Date(startTime * 1000); // UNIX timestamp, kalikan 1000
    } else {
        console.error("Invalid startTime format:", startTime);
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    // Validasi apakah start date valid
    if (isNaN(start.getTime())) {
        console.error("Invalid start date after conversion:", start);
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    const end = new Date();
    const durationMs = end - start;

    const hours = Math.floor(durationMs / (1000 * 60 * 60));
    const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((durationMs % (1000 * 60)) / 1000);

    return { hours, minutes, seconds };
}

function convertToWIB(timestamp) {
    let date;

    // Cek apakah input adalah string dalam format ISO 8601
    if (typeof timestamp === "string") {
        date = new Date(timestamp); // Langsung konversi tanpa dikalikan 1000
    } else if (typeof timestamp === "number") {
        date = new Date(timestamp * 1000); // Anggap timestamp UNIX (detik), kalikan 1000
    } else {
        console.error("Invalid timestamp format:", timestamp);
        return "Invalid timestamp format";
    }

    // Cek apakah objek date valid
    if (isNaN(date.getTime())) {
        console.error("Invalid date after conversion:", date);
        return "Invalid date";
    }

    // Array nama hari dan bulan dalam bahasa Indonesia
    const namaHari = [
        "Minggu",
        "Senin",
        "Selasa",
        "Rabu",
        "Kamis",
        "Jumat",
        "Sabtu",
    ];
    const namaBulan = [
        "Januari",
        "Februari",
        "Maret",
        "April",
        "Mei",
        "Juni",
        "Juli",
        "Agustus",
        "September",
        "Oktober",
        "November",
        "Desember",
    ];

    const hari = namaHari[date.getDay()]; // Mengambil nama hari dari array
    const tanggal = String(date.getDate()).padStart(2, "0");
    const bulan = namaBulan[date.getMonth()]; // Mengambil nama bulan dari array
    const tahun = date.getFullYear();
    const jam = String(date.getHours()).padStart(2, "0");
    const menit = String(date.getMinutes()).padStart(2, "0");
    const detik = String(date.getSeconds()).padStart(2, "0");

    return `${hari}, ${tanggal} ${bulan} ${tahun} ${jam}:${menit}:${detik}`;
}

client.once("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);

    const jobIDN = new cron.CronJob("*/30 * * * * *", livestreamNotificationIdn); // ini diset terserah tapi jangan terlalu cepet meledak tar servernya
    jobIDN.start();

    const jobShowroom = new cron.CronJob("*/30 * * * * *", livestreamNotificationShowroom); // ini diset terserah tapi jangan terlalu cepet meledak tar servernya
    jobShowroom.start();
});

// Login ke bot Discord
client.login(BOT_TOKEN);
