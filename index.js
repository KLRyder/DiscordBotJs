const Discord = require('discord.js');
const mysql = require('mysql');
const Ytdl = require('ytdl-core-discord');
const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
const CONFIG = require('./config.json');
const client = new Discord.Client();
const rollRegex = /\.roll (\d+)(d)(\d+)(\+(\d+))?/i;
const redditHttp = new XMLHttpRequest();
const pollHttp = new XMLHttpRequest();

// noinspection SpellCheckingInspection
const mysqlConnection = mysql.createConnection({
    host: CONFIG.SQLHost,
    user: CONFIG.SQLUsername,
    password: CONFIG.SQLPassword,
    database: CONFIG.SQLDatabase,
    charset: CONFIG.SQLCharset
});

let voiceCon;
let volume = 0.1;
let redditRequestHolder = new Map();
let pollRequestHolder = [];

mysqlConnection.connect(function (err) {
    if (err) throw err;
    console.log("Connected to mySQL");
});

function findCommand(msg) {
    let commands;
    let array;
    commands = RegExp('\.harvest|\.punishment|\.yt|\.volume|\.disconnect|\.dc|\.quote|\.addQuote|\.removeQuote|\.roll|\.poll|\.karma|\.report|\.furyhorn|\.addCom|\.blur', 'mi');
    array = commands.exec(msg);
    if (array != null) {
        return array[0];
    } else {
        return 'none'
    }
}

// start of the harvest function. recursively reads messages from a channel.
//TODO clean up this set of functions, 3 separate pieces are unnecessary here.
function harvestMessagesOuter(channel) {
    let col;
    channel.messages.fetch({limit: 100})
        .then(messages => harvestInner(messages, channel, col))
}

// take previous batch of messages and adds them to current map of messages,
// finds next batch if it exists and repeats, or escapes to harvest final otherwise.
function harvestInner(messages, channel, col) {
    let newCol;
    if (typeof col == 'undefined') {                        // runs on the first time through.
        newCol = messages;
    } else {
        newCol = new Map([...col, ...messages]);    // concatenate the last set of messages with the rest
    }
    if (messages.size < 100) {                              // only occurs when you have all of the messages
        harvestFinal(newCol, channel);
    } else {
        //fetch the next 100 messages
        channel.messages.fetch({
            before: messages.last().id,
            limit: 100
        }).then(newMess => harvestInner(newMess, channel, newCol))
    }
}

function harvestFinal(col, channel) {
    mysqlConnection.query({
        sql: 'CREATE TABLE IF NOT EXISTS ' + mysqlConnection.escape(channel.name) +
            ' (quote_num INT PRIMARY KEY AUTO_INCREMENT, text VARCHAR(16000)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_general_ci;',
        timeout: 40000,
    }, function (err) {
        if (err) {
            console.log("sql error: " + err);
        }
    });

    // assign each quote a number in descending order as they are harvested backwards chronologically,
    // then pop them into the database.
    let i = col.size + 1;
    for (let message of col.values()) {
        i -= 1;
        mysqlConnection.query({
            sql: "INSERT INTO " + channel.name + " (quote_num, text) VALUES (" + i +
                ", \"`?`\") ON DUPLICATE KEY UPDATE quote_num=quote_num;",
            timeout: 40000,
            values: [message.content.toString()]
        }, function (err) {
            if (err) {
                console.log("sql error: " + err);
            }
        })
    }
    console.log(col.size);
}

//
function validateYouTubeUrl(url) {
    if (url !== undefined || url !== '') {
        let regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|\?v=)([^#&?]*).*/;
        let match = url.match(regExp);
        return !!(match && match[2].length === 11);
    }
}

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

redditHttp.onreadystatechange = () => {
    if (redditHttp.readyState === 4 && redditHttp.status === 200) {
        let commentRegex = /commentKarma":(\d+)/;
        let commentKarmaRes = commentRegex.exec(redditHttp.responseText);
        let postRegex = /postKarma":(\d+)/;
        let postKarmaRes = postRegex.exec(redditHttp.responseText);
        let usernameRegex = /username":"([a-zA-Z\-_\d]*)"/;
        let usernameRes = usernameRegex.exec(redditHttp.responseText);
        let commentKarma = commentKarmaRes[1];
        let postKarma = postKarmaRes[1];
        let username = usernameRes[1].toLowerCase();
        redditRequestHolder.get(username).reply("Reddit user " + username + " has " + commentKarma +
            " comment karma and " + postKarma + " post karma. What a nerd.");
        redditRequestHolder.delete(username);
    }
};

pollHttp.onreadystatechange = () => {
    if (pollHttp.readyState === 4) {
        pollRequestHolder.shift().reply("https://strawpoll.com/" + pollHttp.responseText.substr(15, 8));
    }
};

client.on('message', msg => {
    // ignore bots, prevents this from talking to itself
    if (msg.author.bot) {
        return;
    }

    if (msg.channel.id === CONFIG.OneWordChannel && msg.content.toLocaleLowerCase() !== CONFIG.OneWordWord) {
        msg.reply("you fool. you absolute buffoon. you think you can challenge me in my own realm? you think you can rebel against my authority? you dare come into my house and upturn my dining chairs and spill coffee grounds in my Keurig? you thought you were safe in your chain mail armor behind that screen of yours. I will take these laminate wood floor boards and destroy you. I didn’t want war. but i didn’t start it. https://cdn.discordapp.com/attachments/176771207369195521/696726390195880026/unknown.png");
        return;
        // TODO The following doesn't work, as far as I can tell the setVoiceChannel() command was depreciated and
        //  removed like a year ago, and there is no inbuilt replacement. See if you can find a workaround.
        //var member = msg.member;
        //var guild = msg.channel.guild;
        //client.channels.fetch(CONFIG.PunishmentChannel).then(chan => guild.member(member).setVoiceChannel(chan));
    }

    let command = findCommand(msg);
    switch (command) {
        // reads every message sent to a channel and puts them in a locally stored mySQL database.
        case '.harvest':
            client.channels.fetch(msg.content.split(" ")[1])
                .then(channel => harvestMessagesOuter(channel))
                .catch(console.error);
            break;

        // join a designated voice channel on the server and play a preset youtube video.
        case '.punishment':
            if (voiceCon != null) {
                voiceCon.disconnect();
            }
            client.channels.fetch(CONFIG.PunishmentChannel.toString()).then(chan => chan.join()).then(
                conn => playYoutube(conn, CONFIG.PunishmetSong));
            break;

        // change the volume of playing audio, takes values 0.0-1.0, default is 0.1;
        case '.volume':
            if (msg.content.split(" ")[1] >= 0.0 && msg.content.split(" ")[1] <= 1.0) {
                volume = msg.content.split(" ")[1];
            }
            if (voiceCon.dispatcher == null) {
                break;
            } else {
                voiceCon.dispatcher.setVolume(volume);
            }
            break;

        // disconnect from current voice channel.
        case '.dc':
        case '.disconnect':
            if (voiceCon != null) {
                voiceCon.disconnect();
                voiceCon = null;
            }
            break;

        // play audio from provided youtube URL in the voice channel that the sender of the message is in, or replies
        // telling the sender to join a voice channel first.
        case '.yt':
            if (!validateYouTubeUrl(msg.content.split(" ")[1])) {
                msg.reply("invalid youtube URL. Bug my maker if you want me to play soundcloud or whatever.");
            }
            if (msg.member.voice.channel) {
                if (voiceCon == null) {
                    msg.member.voice.channel.join().then(conn => voiceCon = conn).then(() => playYoutube(voiceCon, msg.content.split(" ")[1]));
                } else if (voiceCon.channel !== msg.member.voice.channel) {
                    voiceCon.disconnect();
                    msg.member.voice.channel.join().then(conn => voiceCon = conn).then(() => playYoutube(voiceCon, msg.content.split(" ")[1]));
                } else {
                    playYoutube(voiceCon, msg.content.split(" ")[1])
                }
            } else {
                msg.reply('join a channel first ya dingus')
            }
            break;

        //fetches a random quote from the quotes table on the local DB.
        case '.quote':
            mysqlConnection.query("SELECT * FROM quotes ORDER BY RAND() LIMIT 1", function (err, quote) {
                if (err) {
                    console.log(err);
                }
                msg.channel.send("Quote " + quote[0].quote_num + ": " + quote[0].text);
            });
            break;

        // removes a quote from the quotes table using the quote_number.
        case '.removeQuote':
            if (isNaN(parseInt(msg.content.split[1]))) {
                msg.reply("I need a quote number my dude");
                break;
            }
            mysqlConnection.query('DELETE FROM quotes WHERE quote_num =' + parseInt(msg.content.split(" ")[1]) + ';');
            break;

        // Add a quote to the quote table
        // Usage: .addquote Why am I typing usage into the comments of code that no one will ever read.
        // adds "Why am I typing usage into the comments of code that no one will ever read." to the quotes table or
        // does nothing if it already exists in the table.
        case '.addQuote':
            var substring = msg.content.substr(msg.content.indexOf(" " + 1));
            if (substring !== "") {
                mysqlConnection.query({
                    sql: "INSERT INTO quotes (text) VALUES (\"`?`\") ON DUPLICATE KEY UPDATE quote_num=quote_num;",
                    timeout: 40000,
                    values: [substring]
                }, function (err) {
                    if (err) {
                        console.log("sql error: " + err);
                    }
                })
            }
            break;

        // spawn child process running off of some python code. Currently just a glorified hello world
        // but I'm planning on doing some computer vision work in there.
        case '.testPy':
            let spawn = require("child_process").spawn;
            let process = spawn('python', ["./test.py", "do it work?", "it do"]);
            process.stdout.on('data', data => console.log(data));
            break;

        case '.blur':
            msg.reply("blur triggered");
            const fs = require('fs');
            try {
                msg.attachments.forEach(a => {
                    fs.writeFileSync(`./workingImages/test`, a.file); // Write the file to the system synchronously.
                    console.log(a.name);
                });
            } catch (e){
                msg.reply("Something went really wrong here.");
            }
            break;

        // Roll some dice.
        // Usage ".roll (X)d(Y)" or ".roll (X)d(Y)+(Z)".
        // Rolls X dice with Y sides (optionally adds Z to the combined totals.)
        case '.roll':
            let matches = rollRegex.exec(msg.content);
            if (matches !== null) {
                let runningTotal = 0;
                let rolls = [];
                let currentRoll;
                for (let i = 0; i < matches[1]; i++) {
                    currentRoll = Math.ceil(Math.random() * matches[3]);
                    rolls.push(currentRoll);
                    runningTotal += currentRoll;
                }
                if (matches[5] != null) {
                    runningTotal += parseInt(matches[5]);
                    rolls.push(matches[4]);
                }
                let toReturn = [];
                toReturn.push(
                    "Rolled ",
                    runningTotal.toString(),
                    "\n rolls: "
                );
                for (let i = 0; i < rolls.length; i++) {
                    toReturn.push(rolls[i], ", ")
                }
                toReturn.pop();
                msg.reply(toReturn.join(""));
            } else {
                msg.reply("invalid roll formatting")
            }
            break;

        // lookup the current karma of any reddit account.
        // Usage: .karma (redditAccName)
        // replies with the specified accounts comment and post karma,
        // or the karma of a default account if none is provided.
        case '.karma':
            let redditAccName;
            const redditAccNameRegex = /\.karma ([a-zA-z_\-\d]+)/;
            let redditAccNameRes = redditAccNameRegex.exec(msg.content);
            if (redditAccNameRes != null && redditAccNameRes[1].length <= 20 && redditAccNameRes[1].length >= 3) {
                redditAccName = redditAccNameRes[1];
            } else {
                redditAccName = CONFIG.DefaultRedditAccount;
            }
            let redditURL = 'https://www.reddit.com/user/' + redditAccName + '/';
            redditHttp.open("GET", redditURL);
            redditHttp.send();
            redditRequestHolder.set(redditAccName.toLowerCase(), msg);
            break;

        // stores an instance of a report of a user in a guild including when the report happened and who reported them.
        // stores reason for report if any is given.
        // usage: .report discordUserName
        // Response: "discordUserName now has 42 report(s)"
        case '.report':
            const reportRegex = /\.report <@!(\d+)>(?:(?: )(.*))?/;
            let reportRes = reportRegex.exec(msg.content);
            if (reportRes) {
                mysqlConnection.query('INSERT INTO reports (username, reported_by, date_of_report, reason_of_report) VALUES (?,?,?,?);',
                    [reportRes[1], msg.author.id, msg.createdAt, reportRes[2]],
                    function (err) {
                        if (err) {
                            console.log(err);
                        }
                        mysqlConnection.query("SELECT COUNT(*) AS reports FROM reports WHERE username = ?",
                            reportRes[1],
                            function (err, result) {
                                if (err) {
                                    console.log(err);
                                }
                                msg.reply("Reported. <@!" + reportRes[1] + "> now has " + result[0].reports + " report(s)");
                            })
                    });
            }
            break;

        case ".furyhorn":
            msg.reply("https://cdn.discordapp.com/attachments/459386440636170249/702244329363603526/furyhorn_dies_again.PNG");
            break;

        // creates a strawpoll link.
        // usage: .poll title~option1~option2(~option3~option4....)
        // options 3+ are optional
        // Response:
        case '.poll':
            let pollJSON;
            let pollOptions = msg.content.substr(6).split("~");
            if (pollOptions.length < 3) {
                msg.reply("please use the following format to create a poll \n.poll Question title ~ option 1 ~ option 2 ~ options 3+ are optional");
            }
            pollJSON = require("./pollTemplate.json");
            pollJSON.poll.title = pollOptions.shift();
            pollJSON.poll.answers = pollOptions;
            pollHttp.open("POST", "https://strawpoll.com/api/poll");
            pollHttp.send(JSON.stringify(pollJSON));
            pollRequestHolder.push(msg);
            break;
        case 'none':
        case 'default':
            break;
    }
});

async function playYoutube(conn, url) {
    conn.play(await Ytdl(url), {type: 'opus'});
    conn.dispatcher.setVolume(volume);
}

client.login(CONFIG.DiscordBotToken);