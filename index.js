const uri = process.env.MONGODB_URI
const { MongoClient } = require("mongodb");
const express = require("express")
const helmet = require("helmet")
const cors = require("cors")
const hpp = require("hpp")
const axios = require("axios")
const cheerio = require("cheerio")
const rateLimit = require("express-rate-limit")
const path = require("path");
const { strict } = require("assert");
const { raw } = require("express");
const { index } = require("cheerio/lib/api/traversing");
const app = express()
const mongo = new MongoClient(uri)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15 * 10, // limit each IP to 100 requests per windowMs
    message: "exceeded maximum number of requests per minute"
})

app.set('trust proxy', 1)

app.use(limiter)
app.use(helmet())
app.use(helmet.contentSecurityPolicy({ useDefaults: true, directives: { "img-src": ["'self'", "m.media-amazon.com"] } }))
app.use(cors({ origin: "http://mostfavorite.herokuapp.com", credentials: true, optionsSuccessStatus: 200 }))
app.use(express.json({ limit: "1kb" }))
app.use(express.urlencoded({ extended: false, limit: "1kb" }))
app.use(express.static(path.join(__dirname, 'public')))
app.use(hpp())

app.get('/', (req, res) => {
    //console.log("visited")
    res.sendFile("index.html")
    //res.send("hello world")
})

app.use((req, res) => {
    (async () => {
        //console.log(req.body);
        try {
            const sanitized = {}
            Object.keys(req.body).forEach(field => {
                sanitized[sanitize(field)] = sanitize(req.body[field])
            })
            let skip = 0
            let limit = 50
            if ("skip" in sanitized) {
                skip = parseInt(sanitized["skip"])
                delete sanitized["skip"]
            }
            if ("limit" in sanitized) {
                limit = Math.min(parseInt(sanitized["limit"]), 50)
                delete sanitized["limit"]
            }
            const query = await paramsToQuery(sanitized)
            const result = await searchRecords(query, skip, limit)
            result["limit"] = limit
            //console.log(result)
            res.status(200).json(result)
        } catch (error) {
            console.log(error)
            res.status(500).send("out of service: " + error)
        }
    })();
    //res.status(404).send("404")
})

process.on('SIGINT', function() {
    mongo.close(function () {
        console.log('database disconnected on app termination');
        process.exit(0);
    })
})

mongo.connect().then(data => {
    const port = process.env.PORT || 8081;
    app.listen(port)
})

// database operations
function sanitize(input) {
    if (typeof input !== "string") {
        return ""
    } else {
        const sanitized = input.replace(/[^a-zA-Z0-9_,-]/, "")
        return sanitized
    }
}
async function paramsToQuery(parameters) {
    const query = {}
    query["$and"] = []
    query["$and"].push({ "_id": { "$ne": "cursor" } })
    query["$and"].push({ "_id": { "$ne": "genres" } })
    Object.keys(parameters).forEach(field => {
        const toPush = {}
        if (field === undefined || field === null || field === "search" || parameters[field] === undefined || parameters[field] === null || !parameters[field].length || parameters[field][0] === ",") {
            return
        }
        if (field === "type") {
            toPush["type"] = { "$eq": parameters[field] }
        } else if (field === "notgenre") {
            toPush["genre"] = { "$nin": parameters[field].split(",") }
        } else if (field === "genre") {
            toPush["genre"] = { "$all": parameters[field].split(",") }
        } else if (field === "nudity" || field === "violence" || field === "profanity" || field === "substance" || field === "fear") {
            toPush[field] = { "$lte": parameters[field] }
        }
        // else { // commented out against high number of unnecessary inputs
        //     toPush[field] = { "$all": parameters[field].split(",") }
        // }
        query["$and"].push(toPush)
    })
    if (!("type" in parameters)) {
        const toPush = {}
        toPush["type"] = { "$eq": "film" }
        query["$and"].push(toPush)
    }
    if ("search" in parameters && parameters["search"].length && parameters["search"][0] !== ",") {
        const toSearch = parameters["search"].split(",")
        toSearch.length = 10
        toSearch.forEach(word => {
            const toPush = {}
        toPush["title"] = { "$regex": ".*" + word + ".*", "$options": "si" }
            query["$and"].push(toPush)
        })
    }
    //console.log("query", query["$and"])
    return query
}
async function searchRecords(query, skip, limit) {
    try {
        //await mongo.connect()
        const items = await mongo.db("favorite").collection("media").find(query).sort({ "vote": -1, "rate": -1 }).skip(skip).limit(limit).toArray()
        const count = await mongo.db("favorite").collection("media").find(query).count()
        const tags = await mongo.db("favorite").collection("media").find({ "_id": { "$eq": "genres" } }, { projection: { "_id": 0 } }).toArray()
        const result = {count: count, items: items, tags: tags[0]["genres"]}
        //console.log(result)
        return result
    } catch (error) {
        throw new Error("record(s) could not be searched: " + error)
    } finally {
        //await mongo.close()
    }
}
async function upsertRecord(record) {
    try {
        //await mongo.connect()
        await mongo.db("favorite").collection("media").replaceOne({ _id: record._id }, record, { upsert: true })
        const genres = await mongo.db("favorite").collection("media").findOne({ _id: "genres" })
        //console.log(genres["genres"])
        const initialLength = genres["genres"].length
        record["genre"].forEach(genre => {
            if (!genres["genres"].includes(genre)) {
                genres["genres"].push(genre)
            }
        });
        if (initialLength !== genres["genres"].length) {
            await mongo.db("favorite").collection("media").replaceOne({ _id: "genres" }, genres)
        }
        return true
    } catch (error) {
        throw new Error("record could not be upserted: " + error)
    } finally {
        //await mongo.close()
    }
}
async function setCursor(type, line, time) {
    try {
        //await mongo.connect()
        await mongo.db("favorite").collection("media").replaceOne({ _id: "cursor" }, { type: type, line: line, time: time })
        return true
    } catch (error) {
        throw new Error("cursor could not be set: " + error)
    } finally {
        //await mongo.close()
    }
}
async function getCursor() {
    try {
        //await mongo.connect()
        return await mongo.db("favorite").collection("media").findOne({ _id: "cursor" })
    } catch (error) {
        throw new Error("cursor could not be received: " + error)
    } finally {
        //await mongo.close()
    }
}

// handling unhandled
process.on('unhandledRejection', (reason, p) => {
    console.log('unhandled rejection at: promise', p, 'reason:', reason)
})

// background processing
const wait = (time) => {
    return new Promise((success, failure) => {
        setTimeout(() => success("data"), time)
    })
}
const fetchID = (type, line) => {
    return new Promise((success, failure) => {
        let votes = ""
        let holder = ""
        if (type === "game") {
            votes = 1000
            holder = "video_game"
        } else {
            votes = 100000
            holder = "feature"
        }
        axios({ method: "GET", url: "https://www.imdb.com/search/title/?title_type=" + holder + "&user_rating=6.7,10.0&num_votes=" + votes + ",&adult=include&view=simple&sort=num_votes,desc&count=1&start=" + line })
            .then(response => {
                const $ = cheerio.load(response.data)
                const fullLink = $(".lister-item-image").find("a").attr("href")
                if (fullLink === undefined || fullLink.length === 0) {
                    return success("")
                } else {
                    const id = (fullLink.split("/")[2]).substring(2)
                    if (!id.length) {
                        return success(id)
                    } else {
                        let pid = "" + id
                        //while (pid.length < 19) {
                        //    pid = "0" + pid
                        //}
                        return success(pid)
                    }
                }
            })
            .catch(error => {
                return failure("id could not be acquired: " + error)
            })
    })
}
const fetchRecord = (id, result) => {
    return new Promise((success, failure) => {
        axios({ method: "GET", url: "https://www.imdb.com/title/tt" + id })
            .then(response => {
                const $ = cheerio.load(response.data)
                result._id = id
                result.title = $(".TitleHeader__TitleText-sc-1wu6n3d-0").text()
                result.genre = []
                $(".Storyline__StorylineWrapper-sc-1b58ttw-0").find(".Storyline__StorylineMetaDataList-sc-1b58ttw-1").find("[data-testid='storyline-genres']").find("div").find("ul").find("li")
                    .each(function () {
                        result.genre.push($(this).find("a").text().toLocaleLowerCase())
                    })
                const labels = $(".TitleBlock__TitleMetaDataContainer-sc-1nlhx7j-2")
                if (labels.find("ul:eq(0)").children().length < 2) { // not rated
                    return failure("not rated")
                } else if (labels.find("ul li:eq(0)").children().length === 0) { // first element is type
                    result.date = labels.find("ul li:eq(1) a").text().substring(0, 4)
                    if (labels.find("ul li:eq(0)").text().toLocaleLowerCase().indexOf("series") !== -1) { // has type series
                        result.type = "series"
                    } else if (labels.find("ul li:eq(0)").text().toLocaleLowerCase().indexOf("short") !== -1) { // has type short
                        result.type = "short"
                    } else if (labels.find("ul li:eq(0)").text().toLocaleLowerCase().indexOf("game") !== -1) { // has type game
                        result.type = "game"
                    } else { // film
                        result.type = "film"
                    }
                } else { // first element is date
                    result.date = labels.find("ul li:eq(0) a").text().substring(0, 4)
                    if (result.genre.some(genre => { return genre === "documentary" })) { // has genre documentary
                        result.type = "documentary"
                    } else if (result.genre.some(genre => { return genre === "short" })) { // has genre short
                        result.type = "short"
                    } else { // film
                        result.type = "film"
                    }
                }
                result.rate = rateToNumber($(".AggregateRatingButton__RatingScore-sc-1ll29m0-1").eq(0).text())
                result.vote = voteToNumber($(".AggregateRatingButton__TotalRatingAmount-sc-1ll29m0-3").eq(0).text())
                result.image = $(".ipc-image").attr("src")
                result.short = $(".GenresAndPlot__TextContainerBreakpointL-cum89p-1").text()
                if (result.image === undefined) {
                    return failure("no poster")
                }
                return success(result)
            })
            .catch(error => {
                return failure(error)
            })
    })
}
const fetchAdvisory = (id, result) => {
    return new Promise((success, failure) => {
        axios({ method: "GET", url: "https://www.imdb.com/title/tt" + id + "/parentalguide" })
            .then(response => {
                const $ = cheerio.load(response.data)
                result.nudity = severityToNumber($("#advisory-nudity").find("span:eq(0)").text())
                result.violence = severityToNumber($("#advisory-violence").find("span:eq(0)").text())
                result.profanity = severityToNumber($("#advisory-profanity").find("span:eq(0)").text())
                result.substance = severityToNumber($("#advisory-alcohol").find("span:eq(0)").text())
                result.fear = severityToNumber($("#advisory-frightening").find("span:eq(0)").text())
                return success(result)
            })
            .catch(error => {
                return failure(error)
            })
    })
}
const severityToNumber = (severity) => {
    switch (severity) {
        case "None":
            return "0"
        case "Mild":
            return "1"
        case "Moderate":
            return "2"
        case "Severe":
            return "3"
        default:
            return "4"
    }
}
const rateToNumber = (text) => {
    const number = parseFloat(text)
    if (number > 8.8) {
        return "3"
    } else if (number > 7.7) {
        return "2"
    } else {
        return "1"
    }
}
const voteToNumber = (text) => {
    const number = text.split(/[a-zA-Z]/)[0]
    const last = text.substring(text.length - 1)
    if (last === "B" || last === "b") {
        return "" + parseFloat(number) * 1000000000
    } else if (last === "M" || last === "m") {
        return "" + parseFloat(number) * 1000000
    } else if (last === "K" || last === "k") {
        return "" + parseFloat(number) * 1000
    } else {
        return "" + parseFloat(number)
    }
}

loop()

async function loop() {
    const maxGap = 12 * 60 * 60 * 1000
    const minGap = 10 * 60 * 1000
    while (true) {
        // wait for some time, like three minutes or so, cuz we'll be opening 3 pages and reading one entries and writing two entries
        // get last index and last type
        // if greater than 4444, set to one and switch type, and continue
        // search title for the corresponding index
        // if empty, set to one and switch type, and continue
        // fetch record and update database
        // increment last index
        const result = {}
        const cursor = {}
        let abort = false
        let alter = false
        //console.log("waiting...")
        await wait(minGap).catch(err => { abort = true; console.log(err) })
        await getCursor()
            .then(data => {
                cursor.time = data.time
                cursor.type = data.type
                cursor.line = data.line
                if (parseInt(cursor.line) > 4444) {
                    alter = true
                    throw new Error(">4444")
                }
            })
            .catch(err => {
                abort = true
                console.log(err)
            })
        console.log("delay: " + cursor.time)
        if (cursor.time === undefined) {
            abort = true
            await wait(minGap).catch(err => { abort = true; console.log(err) })
        } else if (parseInt(cursor.time) > 0) {
            abort = true
            await wait(maxGap).catch(err => { abort = true; console.log(err) })
            await setCursor(cursor.type, cursor.line, "" + (parseInt(cursor.time) - 1)).catch(err => { abort = true; console.log(err) })
        }
        if (!abort) {
            //console.log(cursor)
            await fetchID(cursor.type, cursor.line)
                .then(data => {
                    if (data.length === 0) {
                        alter = true
                        abort = true
                        throw new Error("empty id")
                    } else {
                        return data
                    }
                })
                .then(data => { return fetchRecord(data, result) })
                .then(data => { return fetchAdvisory(data._id, result) })
                .then(data => { return upsertRecord(result) })
                .then(data => { console.log("successful") })
                .catch(err => {
                    abort = true
                    console.log(err)
                })
        }
        if (cursor.type !== undefined) {
            if (alter) {
                if (cursor.type === "game") {
                    await setCursor("film", "1", "30").catch(err => { console.log(err) })
                } else {
                    await setCursor("game", "1", "0").catch(err => { console.log(err) })
                }
                console.log("switched")
            } else if (abort) {
                await setCursor(cursor.type, cursor.line, cursor.time).catch(err => { console.log(err) })
                console.log("aborted")
            } else {
                await setCursor(cursor.type, "" + (parseInt(cursor.line) + 1), cursor.time).catch(err => { console.log(err) })
                console.log("incremented")
            }
        }
    }
}
