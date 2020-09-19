import { credentials } from "./credentials.js";

const CURRENT_VERSION = "0.1.0";

const customLocalStorage = {
    getContent: function() {
        if(!localStorage.hasOwnProperty('spotify_util') || !JSON.parse(localStorage.getItem('spotify_util')).hasOwnProperty("spotifyparallel")) localStorage.setItem('spotify_util', JSON.stringify({ ...JSON.parse(localStorage.getItem('spotify_util')), spotifyparallel:{} }));
        return JSON.parse(localStorage.getItem("spotify_util"))["spotifyparallel"] || {};
    },
    set: function(key, val) {
        //val can be a js obj, we'll convert it all in here
        let new_storage_obj = { 
            ...JSON.parse(localStorage.getItem("spotify_util")),    //import all of spotiy_util because we are going to update all of spotify_util (want to make sure we dont lose the other keys)
            spotifyparallel: { //override the spotifyparallel key specifically
                ...this.content,    //carry over everything from spotifyparallel
                [key]:val           //then overwrite the given key with the given value
            } 
        };
        localStorage.setItem("spotify_util", JSON.stringify(new_storage_obj));  //stringify and set the new obj
    }
};

var user_credentials = null,
    CURRENTLY_RUNNING = false,
    database,
    user_cache = {};

const callSpotify = function (url, data) {
    if(!user_credentials) return new Promise((resolve, reject) => reject("no user_credentials"));
    return $.ajax(url, {
        dataType: 'json',
        data: data,
        headers: {
            'Authorization': 'Bearer ' + user_credentials.token
        },
        beforeSend:function(jQxhr){
          jQxhr.url=url;
        }
    });
}

const resolvePromiseArray = function (promise_array, callback) {
    Promise.all(promise_array).then((results) => callback(false, results)).catch((err) => {
        console.log(`error found in resolvePromiseArray: `, err);
        callback(true, err);
        //removing ^ that should stop the TypeError: finished_api_calls.forEach is not a function
    });
}

const okToRecursivelyFix = function (error_obj) {
    //determine if an error object is an api rate issue that can be fixed by calling it again,
    //or an error on our end (such as syntax) that can't be fixed by recalling the api
    console.log("checking if err is ok to recursively fix", error_obj);
    if (error_obj.status >= 429) return true;
    else {
        console.log("err NOT ok to recursively fix", error_obj);
        return false
    };
}

const loginWithSpotify = function () {

    if (document.location.hostname == 'localhost') {
        credentials.spotify.redirect_uri = 'http://localhost:8888/index.html';
    }

    let url = 'https://accounts.spotify.com/authorize?client_id=' + credentials.spotify.client_id +
        '&response_type=token' +
        '&scope=' + encodeURIComponent(credentials.spotify.scopes) +
        '&redirect_uri=' + encodeURIComponent(credentials.spotify.redirect_uri);

    //redirect the page to spotify's login page. after login user comes back to our page with a token in
    //page hash, or, if they're already logged in, a token in customLocalStorage's user_credentials
    document.location = url;
}

const loadApp = function () {
    $("#user1").val(`https://open.spotify.com/user/${user_credentials.uid}`).trigger("input");
    $("#user2").trigger("input");
    $("#login-page").addClass("hidden");
    $("#main-page").removeClass("hidden");
    setTimeout(function(){
        confirm('You need to refresh the page before proceeding') ? location.reload() : location.reload();
    }, (user_credentials.expires - getTime()) * 1000);
}

const getTime = function () {
    return Math.round(new Date().getTime() / 1000);
}

/**
 * Scales a given number in one domain to an equivelent number in a target other domain
 * @param {Number} n - Number to be scaled
 * @param {Number} given_min - Lower limit of n's domain
 * @param {Number} given_max - Upper limit of n's domain
 * @param {Number} target_min - Lower limit of new domain
 * @param {Number} target_max  - Upper limit of new domain
 * @returns {Number} A number scaled to the target new domain
 */
function scaleNumber(n, given_min, given_max, target_min, target_max) {
    let given_range = given_max - given_min,
    target_range = target_max - target_min;
    return ((n - given_min) * target_range / given_range) + target_min;
}

const progress_bar = new ProgressBar.Line('#progress-bar', {
    color: '#1DB954',
    duration: 300,
    easing: 'easeOut',
    strokeWidth: 2
});

var pb = { min_val:0, max_val:0.5 };   //current min & max val for the progressbar
function progressBarHandler({current_operation, total_operations, stage = 1, ...junk} = {}) {
    //the idea is that each api call we make results in the progress bar updating
    //we need to get the total number of calls that will be made
    //let total_operations = total_tracks + Math.ceil(total_tracks / 20) + Math.ceil(total_tracks / 100);
                            //+ recursive_operations.missing_tracks + recursive_operations.get_album_calls;
    //^ see the algorithm used in estimateTimeTotal
    if(stage == "done") {
        progress_bar.animate(1);
        $("#estimated-time-remaining p").text("Done!");
        return;
    }

    let animate_value = 0,
        estTimeText = "Unknown";

    let stage_text = {
        1:() => {
            if(!junk.uid) return 'Getting playlists...';
            else return `Getting playlists for ${user_cache[junk.uid].display_name}...`;
        },
        2:() => {
            if(!junk.playlist_name) return `Retrieving playlist songs...`;
            else return `Retrieving songs from playlist ${junk.playlist_name}...`;
        },
        3:() => "Filtering songs...",
        4:() => {
            if(!junk.uid) return 'Getting artists...';
            else return `Getting artists for ${user_cache[junk.uid].display_name}...`;
        }
    },
    total_stages = Object.keys(stage_text).length;

    //console.log(`stage: ${stage}, value: ${current_operation}/${total_operations}`);

    const [min_stage_val, max_stage_val] = [(stage - 1) / total_stages, stage / total_stages];
    const [min_pb_val, max_pb_val] = [scaleNumber(min_stage_val, 0, 1, pb.min_val, pb.max_val), scaleNumber(max_stage_val, 0, 1, pb.min_val, pb.max_val)];
    //scale it to be within the stage limit, then scale it to reflect the overall pb domain we're limited to (pb.min_val, pb.max_val)
    animate_value = scaleNumber(current_operation, 0, total_operations, min_pb_val, max_pb_val);
    //console.log(animate_value);

    if(animate_value < progress_bar.value()) animate_value = progress_bar.value();  //prevent the progressbar from ever going backwards
    if(animate_value > 1) animate_value = 1;    //prevent the progressbar from performing weird visuals
    progress_bar.animate(animate_value);

    $("#estimated-time-remaining p").text(stage_text[stage]());
}

//taken from https://stackoverflow.com/a/7343013
function round(value, precision) {
    var multiplier = Math.pow(10, precision || 0);
    return Math.round(value * multiplier) / multiplier;
}

const performAuthDance = function () {
    // if we already have a token and it hasn't expired, use it,
    if ('user_credentials' in customLocalStorage.getContent()) {
        user_credentials = customLocalStorage.getContent().user_credentials;
    }
    if (user_credentials && user_credentials.expires > getTime()) {
        console.log("found unexpired token!");
        location.hash = ''; //clear the hash just in case (this can be removed later)
        //load our app
        loadApp();
    } else {
        // we have a token as a hash parameter in the url
        // so parse hash
        var hash = location.hash.replace(/#/g, '');
        var all = hash.split('&');
        var args = {};
        all.forEach(function (keyvalue) {
            let idx = keyvalue.indexOf('=');
            let key = keyvalue.substring(0, idx);
            let val = keyvalue.substring(idx + 1);
            args[key] = val;
        });
        if (typeof (args['access_token']) != 'undefined') {
            console.log("found a token in url");
            let g_access_token = args['access_token'];
            let expiresAt = getTime() + 3600 - 300 /*5 min grace so that token doesnt expire while program is running*/;
            if (typeof (args['expires_in']) != 'undefined') {
                let expires = parseInt(args['expires_in']);
                expiresAt = expires + getTime() - 300;
            }
            user_credentials = {
                token: g_access_token,
                expires: expiresAt
            }
            callSpotify('https://api.spotify.com/v1/me').then((user) => {
                    user_credentials.uid = user.id;
                    customLocalStorage.set("user_credentials", user_credentials);
                    location.hash = '';
                    //load app
                    loadApp();
                }, (e) => {
                    //prompt user to login again
                    location.hash = ''; //reset hash in url
                    console.log(e.responseJSON.error);
                    alert("Can't get user info");
                }
            );
        } else {
            // otherwise, have user login
            console.log("user needs to login!");
        }
    }
}

const checkInput = function (input) {
    //checks user input to ensure it contains a user id 
    input = input.trim();   //remove whitespace
    if(input.startsWith('http') || input.includes('open.spotify.com') || input.startsWith('spotify:user:')) return true;
    return false;
}

const getId = function getIdFromUserInput(input) {
    input = input.trim();
    let id = undefined; //default to undefined for error handling
    //if we have a url
    if(input.startsWith('http') || input.includes('open.spotify.com')) id = input.split('/').pop().split('?')[0];
    //if we have a uri
    else if(input.startsWith('spotify:user:')) id = input.split(':').pop(); //even though .pop() is somewhat inefficent, its less practical to get the length of the array and use that as our index
    return id;
}

const getUserPlaylists = function (uid = '') {
    //retrieves the playlists of the currently logged in user and checks them against
    //global options. stores the hrefs of playlist track list in a global array

    let playlist_objects = [];

    const recursivelyGetAllPlaylists = function (url) {
        return new Promise((resolve, reject) => {
            callSpotify(url).then(async (res) => {
                res.items.forEach((playlist, index) => {
                    if(playlist.owner.id == uid && 
                        playlist.public &&
                        playlist.tracks.total > 0 &&    //remove playlists without any songs, this causes too many complications later in the code to justify including them
                        playlist.tracks.total <= 5000) playlist_objects.push(playlist);
                    progressBarHandler({current_operation:index + res.offset + 1, total_operations:res.total, stage:1, uid:uid});
                });
                
                //if we have more playlists to get...
                if(res.next) await recursivelyGetAllPlaylists(res.next);
                //await should wait until all promises complete
                resolve(playlist_objects);
            }).catch(err => {
                console.log("error in getUserPlaylists... attempting to fix recursively", err);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                        setTimeout(() => resolve(recursivelyGetAllPlaylists(url)), 500); //wait half a second before calling api again
                    }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
                    .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
                else return err; //do something for handling errors and displaying it to the user
            });
        });
    }

    //the recursive function returns a promise
    return recursivelyGetAllPlaylists(`https://api.spotify.com/v1/users/${uid}/playlists?limit=50`);
}


//ranked in order of high priority to low priority
const keywords = [
    [
        'fav',
        'favs',
        'fave',
        'faves',
        'favorite',
        'favorites',
        'favourite',
        'favourites'
    ],
    [
        'best',
        'good',
        'great',
        'legend',
        'legends',
        'legendary',
        'amazing',
        'awesome',
        'awesomeness',
        'enjoy',
        'enjoying'
    ]
];
//hasWord func taken from https://stackoverflow.com/a/55163552
const hasWord = (str, word) => str.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").split(/\s+/).includes(word);

/**
 * @param {Object} playlist_obj - A Spotify playlist object (that includes tracks)
 * @param {Array} top_tracks - An array of the user's top 50 tracks
 * @param {Array} top_artists - An array of the user's top 25 artists
 * @returns {Number} The score for the playlist
 */
const checkPlaylist = function ({playlist_obj, top_tracks, top_artists} = {}) {
    let score = 0;
    for(const keyword of keywords[0]) {
        if(hasWord(playlist_obj.name.toLowerCase(), keyword)) {
            //check if it's preceeded by "not"
            let split_word = playlist_obj.name.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").split(/\s+/);
            let kw_index = split_word.indexOf(keyword);
            if(kw_index < 0) console.log('err: kw_index is less than zero');
            //check the previous three words for the word "not"
            let containsNot = false;
            for(let i = kw_index-1; i >= kw_index-3 && i >= 0; i--) {
                if(split_word[kw_index] == 'not' || split_word[kw_index].includes("n't")) containsNot = true;
            }
            if(containsNot) score -= 30; //likely inference is it's not their favorite
            else score += 50;
        }
        if(hasWord(playlist_obj.description.toLowerCase(), keyword)) {
            //check if it's preceeded by "not"
            let split_word = playlist_obj.description.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").split(/\s+/);
            let kw_index = split_word.indexOf(keyword);
            if(kw_index < 0) console.log('err: kw_index is less than zero');
            //check the previous three words for the word "not"
            let containsNot = false;
            for(let i = kw_index-1; i >= kw_index-3 && i >= 0; i--) {
                if(split_word[i] == 'not' || split_word[i].includes("n't")) containsNot = true;
            }
            if(containsNot) score -= 20; //likely inference is it's not their favorite
            else score += 35;
        }
    }
    if(playlist_obj.name.toLowerCase().includes("christmas") || playlist_obj.name.toLowerCase().includes("xmas")) score -= 50;
    if(playlist_obj.description.toLowerCase().includes("christmas") || playlist_obj.description.toLowerCase().includes("xmas")) score -= 35;
    for(const keyword of keywords[1]) {
        if(hasWord(playlist_obj.name.toLowerCase(), keyword)) score += 10;
        if(hasWord(playlist_obj.description.toLowerCase(), keyword)) score += 5;
    }

    //check tracks
    if(playlist_obj.hasOwnProperty('items')) {
    }

    return score;
}

/**
 * Retrieves all tracks from a playlist and adds them to a global array. Ignores local files
 * 
 * @param {string} playlist_id - The ID of the playlist to retrieve tracks from
 * @return {promise} - A promise that resolves with an array of tracks (only uris and explicitness) from the requested playlist
 */
const getAllPlaylistTracks = function (playlist_id) {
    let options = {
        //fields:"next,items.track(uri,id,explicit,is_local,name,artists)",
        market:"from_token",
        limit:100
    }, playlist_songs = [];
    
    function recursivelyRetrieveAllPlaylistTracks(url, options = {}) {
        return new Promise((resolve, reject) => {
            callSpotify(url, options).then(async res => {
                //go thru all tracks in this api res and push them to array
                for(const item of res.items) {
                    let track = item["track"];
                    //found a rare, undocumented case of the track object sometimes returning null, specifically when calling the endpoint for this playlist: 6BbewZJ0Cv6V9XSXyyDBSm
                    //there's also podcasts, so the track has to be of a specific type
                    if(!!track && !track.is_local && track.type == 'track') playlist_songs.push(item);
                }
                //if there's more songs in the playlist, call ourselves again, otherwise resolve
                if(!res.next) {
                    resolve({playlist_songs:playlist_songs, playlist_id:playlist_id});  //resolve an object that will be handeled in our .then() catcher
                } else await recursivelyRetrieveAllPlaylistTracks(res.next).then(res=>resolve(res)).catch(err=>reject(err));    //evidently this then/catch is necessary to get the promise to return something
            }).catch(err => {
                console.log("error in getAllPlaylistTracks... attempting to fix recursively", err);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                        setTimeout(() => resolve(recursivelyRetrieveAllPlaylistTracks(url)), 500); //wait half a second before calling api again
                    }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
                    .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
                else return err; //do something for handling errors and displaying it to the user
            });
        });
    }

    return recursivelyRetrieveAllPlaylistTracks(`https://api.spotify.com/v1/playlists/${playlist_id}/tracks`, options);
}

const getPlaylistTracks = async function (playlist_id = '') {
    //returns an array of all the tracks from a single, given playlist
    try {
        return await getAllPlaylistTracks(playlist_id).then((res_obj) => res_obj.playlist_songs);
    } catch (err) {
        throw err;
    }
}

const getMultipleArtists = function ({artist_ids=[], array_index=0} = {}) {
    //returns array of spotify full album objects

    var url = "https://api.spotify.com/v1/artists/";
    return callSpotify(url, {
        ids: artist_ids.join(",")
    }).then(res => {
        return { artists:res.artists, arr_idx:array_index };
    }).catch(err => {
        console.log("err in getMultipleArtists... will attempt to recursively fix", err);
        if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                setTimeout(() => resolve(getMultipleArtists(artist_ids)), 500); //wait half a second before calling api again
            }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
            .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
        else return err; //do something for handling errors and displaying it to the user
    });
}

const getUserArtists = function(uid='') {
    //assumes user is in the cache

    const user_artists = Object.values(user_cache[uid].artists);
    let id_array = [];
    //request batches of 20 artists
    for (let i = 0; i < user_artists.length; i++) { //for every element in user_artists
        if (i % 20 == 0) { //this is ok to work when i=0. see below for comments and hopefully you can figure out the logic
            id_array.push([]); //if we've filled one subarray with 20 artists, create a new subarray
        }
        id_array[id_array.length - 1].push(user_artists[i].id); //go to the last subarray and add the artist id
        //repeat until we've gone thru every artist in user_artists
    }

    let pending_getArtistsCalls = [];   //initialize a promise array
    return new Promise((resolve, reject) => {
        let id_batch_index = 0,
            current_id_batch,
            stagger_api_calls = setInterval(() => {
                current_id_batch = id_array[id_batch_index];
                if (id_batch_index >= id_array.length) { //once we've reached the end of the id_array
                    //console.log("stopping API batch calls");
                    clearInterval(stagger_api_calls);
                    //resolve all the api calls, then do something with all the resolved calls
                    //"return" b/c the code will otherwise continue to make anotehr api call
                    return resolvePromiseArray(pending_getArtistsCalls, (err, finished_api_calls) => {
                        //console.log(err, finished_api_calls);
                        if (err) reject(finished_api_calls); //finished_api_calls acts as the err msg

                        let artist_array = [];
                        for(const artist_batch of finished_api_calls) {
                            if (!artist_batch) continue;
                            
                            artist_array.push(...artist_batch);
                        }
                        
                        //console.log("resolving getUserArtists promise");
                        resolve(artist_array);
                    });
                }
                //if we still have more tracks to add:
                pending_getArtistsCalls.push(getMultipleArtists({ artist_ids:current_id_batch, array_index:id_batch_index }).then(resObj => {; //no .catch() after getMultipleArtists b/c we want the error to appear in the callback, causing a reject to send to our main() function
                    progressBarHandler({ current_operation:resObj.arr_idx+1, total_operations:id_array.length, stage:4, uid:uid });
                    return resObj.artists;
                }));
                id_batch_index++;
            }, 125);
    });
}

const collectGenres = function (uid='') {
    for(const artist of Object.values(user_cache[uid].artists)) 
        for(const genre_name of artist.genres)  //if there's no genres, it automatically avoids looping. pretty nice lol
            user_cache[uid].genres.hasOwnProperty(genre_name) ?
                user_cache[uid].genres[genre_name].occurrences++ :
                user_cache[uid].genres[genre_name] = { name:genre_name, occurrences:1 };
    
    return true;
}

const sortTrackAppearances = function sortTrackAppearanceCount(track_appearance_object = {}) {
    let appearance_array = Object.entries(track_appearance_object);
    appearance_array.sort((a,b) => b[1] - a[1]);
    let final_obj = {};
    for(const subarray of appearance_array) final_obj[subarray[0]] = subarray[1];
    return final_obj;
}

const validateUserCache = function (uid = '') {
    if(!user_cache[uid]) return false;  //cache is non-existent
    //cache is not fully initialized
    if( !user_cache[uid].hasOwnProperty("display_name") || 
        !user_cache[uid].hasOwnProperty("playlists") ||
        !user_cache[uid].hasOwnProperty("tracks") ||
        !user_cache[uid].hasOwnProperty("artists") ||
        !user_cache[uid].hasOwnProperty("genres"))  return false;
    //cache has missing values
    if(Object.keys(user_cache[uid].playlists).length < 1 ||
        Object.keys(user_cache[uid].tracks).length < 1 ||
        Object.keys(user_cache[uid].artists).length < 1 ||
        Object.keys(user_cache[uid].genres).length < 1) return false;
    return true;
}

const retrieveUserData = async function (uid = 'ollog10') {
    try {
        if(!validateUserCache(uid)) user_cache[uid] = { ...user_cache[uid], playlists: {}, tracks: {}, artists: {}, genres: {} };  //initialize object
        else return; //do something if the user is already in the cache
        const playlist_objects = await getUserPlaylists(uid);   //returns array
        if(playlist_objects.length < 6) return alert(`${uid.display_name} does not have enough playlists for the program to work properly`);
        user_cache[uid].playlists = Object.assign({}, ...(playlist_objects.map(playlist => ({ [playlist.id]: playlist }))));

        /*
            so, this is complicated lol. let me take some time to explain it.
            Obj.entries takes {key:val, key:val} and turns it into [[key, val], [key,val]]
            according to my MDN reference, this method is faster than for-in, because .entries() doesn't enumerate prototype properties.
            my assumption is that this results in Obj.entries() being more efficent.
            i'm also under the impression that this is fast than forEach, otherwise I would probably be using that.
            so i convert the user_cache[uid].playlists object into an iterable array with the aforementioned form,
            and i could just stop there, but i need the index of which playlist i'm currently accessing in order to
            properly update the progressbar. to get the index, i have to call .entries() on the resulting array,
            then destructure it. finally, i'll have access to the index, playlist id, and playlist object, 
            allowing me to call all the functions i need.
        */
        const playlists_ids_and_objects = Object.entries(user_cache[uid].playlists);
        for(const [idx, [playlist_id, playlist_obj]] of playlists_ids_and_objects.entries())  {
            progressBarHandler({current_operation:idx+1, total_operations:playlists_ids_and_objects.length, stage:2, playlist_name:playlist_obj.name});
            user_cache[uid].playlists[playlist_id] = { ...playlist_obj, items: await getPlaylistTracks(playlist_id) };
            if(user_cache[uid].playlists[playlist_id].items.length < 1) delete user_cache[uid].playlists[playlist_id];
            //OH NO HE JUST USED 'delete' REEEEEE
            //chill out. I'm skeptical too, but after doing some research, i've determined the 'delete' keyword to
            //be the best option in this particular case. I need to be able to remove that playlist and still iterate
            //over the playlists object as well as its subproperties without errors.
        }

        progressBarHandler({current_operation:1, total_operations:2, stage:3});
        let tracks = [];
        for(const playlist_obj of Object.values(user_cache[uid].playlists)) 
            for(const item of playlist_obj.items)
                tracks.push(item.track);
                //tracks.push(...playlist_obj.items);
        for (const track of tracks) {
            user_cache[uid].tracks.hasOwnProperty(track.id) ?
                user_cache[uid].tracks[track.id].occurrences++ :
                user_cache[uid].tracks[track.id] = { ...track, occurrences:1 };

            //track_appearance_count.hasOwnProperty(track.id) ? track_appearance_count[track.id]++ : track_appearance_count[track.id] = 1;    //increase track count
            //artists will be an array of artists
            for(const artist of track.artists)
                user_cache[uid].artists.hasOwnProperty(artist.id) ?
                    user_cache[uid].artists[artist.id].occurrences++ :
                    user_cache[uid].artists[artist.id] = { ...artist, occurrences:1 };
                //artist_appearance_count.hasOwnProperty(artist.id) ? artist_appearance_count[artist.id]++ : artist_appearance_count[artist.id] = 1;    //increase artist count
        }
        progressBarHandler({current_operation:2, total_operations:2, stage:3});

        let artist_obj_array = await getUserArtists(uid);   //returns array
        for(const artist_obj of artist_obj_array) {   //overwrite each artist object
            if(!artist_obj) continue;   //apparently it's possible for spotify to return null for some artist objects
            if(artist_obj.type != 'artist') continue;   //also podcasts are a thing, so we're going to ignore those
            user_cache[uid].artists[artist_obj.id] = { ...user_cache[uid].artists[artist_obj.id], ...artist_obj };
        }
        
        collectGenres(uid);
    } catch (err) {
        console.log(`ERROR in try-catch block: ${err}`);
    } finally {
        console.log(`Finished retrieving data for ${user_cache[uid].display_name}`);
        return;
    }
}

const getTopArtistsHTML = function (uid = '') {
    let sorted = Object.values(user_cache[uid].artists).sort((a, b) => (b.occurrences - a.occurrences)),
        comparing_themself = uid == user_credentials.uid,
        new_html = '';
    for(let i=0, artist=sorted.shift(); i < 5; i++, artist=sorted.shift()) {
        new_html += `${i+1}. <a href="${artist.uri}"><b>${artist.name}</b></a>, with <b>${artist.occurrences}</b> occurrences, making up ${round((artist.occurrences/Object.values(user_cache[uid].tracks).reduce((acc, obj) => acc + obj.occurrences, 0)) * 100, 1)}% of ${comparing_themself ? 'your' : 'their'} total tracks`;
        if(i !== 4) new_html += '<br>';
    }
    return new_html;
}

const getTopTracksHTML = function (uid = '') {
    let sorted = Object.values(user_cache[uid].tracks).sort((a, b) => (b.occurrences - a.occurrences)),
        comparing_themself = uid == user_credentials.uid,
        new_html = '';
    for(let i=0, track=sorted.shift(); i < 5; i++, track=sorted.shift()) {
        new_html += `${i+1}. <a href="${track.uri}" title="by ${track.artists[0].name}"><b>${track.name}</b></a>, with <b>${track.occurrences}</b> occurrences, making up ${round((track.occurrences/Object.values(user_cache[uid].tracks).reduce((acc, obj) => acc + obj.occurrences, 0)) * 100, 1)}% of ${comparing_themself ? 'your' : 'their'} total tracks`;
        if(i !== 4) new_html += '<br>';
    }
    return new_html;
}

const getTopGenresHTML = function (uid = '') {
    let sorted = Object.values(user_cache[uid].genres).sort((a, b) => (b.occurrences - a.occurrences)),
        comparing_themself = uid == user_credentials.uid,
        new_html = '';
    for(let i=0, genre=sorted.shift(); i < 5; i++, genre=sorted.shift()) {
        new_html += `${i+1}. <b>${genre.name[0].toUpperCase() + genre.name.slice(1)}</b>, with <b>${genre.occurrences}</b> occurrences, making up ${round((genre.occurrences/Object.values(user_cache[uid].genres).reduce((acc, obj) => acc + obj.occurrences, 0)) * 100, 1)}% of ${comparing_themself ? 'your' : 'their'} total genres`;
        if(i !== 4) new_html += '<br>';
    }
    return new_html;
}

const getRecentSongs = function(uid = '') {
    //i had to get a bit creative with this algorithm. what i do is sort the playlists in
    //descending order by newest song added, then take the top 5 songs of the top 5 playlists
    //and stick those in a temp array. before i stick them in, i inject a key into the item object
    //with the value of the playlist id, because this isn't included by default; it's meant to be
    //assumed based off of the context of the item (playlist, album, etc).
    //I also ensure that there are no duplicates in that array, for UI purposes.
    //I then sort that array by newest song descending, and extract the top 5 songs. i can easily
    //reference which playlist they were taken from thanks to the ID I manually injected.
    let tmp_arr = [],
    sorted_playlist_arr = Object.values(user_cache[uid].playlists).sort((a,b) => new Date(b.items.sort((c,d) => new Date(d.added_at) - new Date(c.added_at))[0].added_at) - new Date(a.items.sort((c,d) => new Date(d.added_at) - new Date(c.added_at))[0].added_at));
    for(let i=0, current_playlist=sorted_playlist_arr[i]; i < 5; current_playlist=sorted_playlist_arr[++i]) 
        for(let j=0, current_item=current_playlist.items.shift(); j < 5; current_item=current_playlist.items.shift()) {
            if(!current_item) break;    //playlist has less than 5 songs in it (kinda dumb but nothing i can do about it lol)
            if(tmp_arr.some(item => item.track.id == current_item.track.id)) continue;  //if track already exists in collected recent songs, move to the next one
            tmp_arr.push({...current_item, playlist_id:current_playlist.id});   //add the track as well as the playlist id for future reference
            j++;    //increment variable once all conditions have been met and all operations have been performed
        }
    tmp_arr.sort((a,b) => new Date(b.added_at) - new Date(a.added_at));
    return tmp_arr;
}

var dotw = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const getRecentSongsHTML = function({uid='', recent_songs = []} = {}) {
    const getDate = function getDateTextSpecificallyForRecentSongs(date = '') {
        //say only day of week if it happened within the past week
        //exclude year if it happened this year
        let dateToCheck = new Date(date);
        
        const today = new Date();
        const yesterday = new Date(today);
        const oneDayBeforeYesterday = new Date(yesterday);
        const twoDayBeforeYesterday = new Date(yesterday);
        const threeDayBeforeYesterday = new Date(yesterday);
        const fourDayBeforeYesterday = new Date(yesterday);
        const fiveDayBeforeYesterday = new Date(yesterday);

        yesterday.setDate(yesterday.getDate() - 1);
        oneDayBeforeYesterday.setDate(yesterday.getDate() - 1);
        twoDayBeforeYesterday.setDate(yesterday.getDate() - 2);
        threeDayBeforeYesterday.setDate(yesterday.getDate() - 3);
        fourDayBeforeYesterday.setDate(yesterday.getDate() - 4);
        fiveDayBeforeYesterday.setDate(yesterday.getDate() - 5);

        if (dateToCheck.toDateString() === today.toDateString()) {
            return 'earlier today';
        } else if (dateToCheck.toDateString() === yesterday.toDateString()) {
            return 'yesterday';
        } else if (dateToCheck.toDateString() === oneDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if (dateToCheck.toDateString() === twoDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if (dateToCheck.toDateString() === threeDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if (dateToCheck.toDateString() === fourDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if (dateToCheck.toDateString() === fiveDayBeforeYesterday.toDateString()) {
            return `on ${dotw[dateToCheck.getDay()]}`;
        } else if(dateToCheck.getFullYear() == today.getFullYear()) {   //check years
            return `on ${months[dateToCheck.getMonth()]} ${dateToCheck.getDate()}`;
        } else return `on ${dateToCheck.getMonth() + 1}-${dateToCheck.getDate()}-${dateToCheck.getFullYear()}`;
    }
    let new_html = '';
    for(let i=0, item=recent_songs.shift(); i < 5; i++, item=recent_songs.shift()) {
        new_html += `Added <a href="${item.track.uri}" target="_blank">"<b>${item.track.name}"</b></a> 
        by <a href="${item.track.artists[0].uri}" target="_blank">${item.track.artists[0].name}</a> 
        to <a href="${user_cache[uid].playlists[item.playlist_id].uri}" target="_blank">${user_cache[uid].playlists[item.playlist_id].name}</a> 
        ${getDate(new Date(item.added_at))}`;
        if(i !== 4) new_html += '<br>';
    }
    return new_html;
}

const getNewestCreatedPlaylist = function (uid = '') {
    //since spotify doesn't store when playlists were created, i had to make my own algorithm to try and deduce this
    //system flow: sort each playlist using the oldest added song as the discriminator, then look at which of those songs
    //is the newest to determine what is likely their most recently created playlist
    return Object.values(user_cache[uid].playlists).sort((a,b) => new Date(b.items.sort((c,d) => new Date(c.added_at) - new Date(d.added_at))[0].added_at) - new Date(a.items.sort((c,d) => new Date(c.added_at) - new Date(d.added_at))[0].added_at))[0];
}

const getOldestCreatedPlaylist = function (uid = '') {
    //since spotify doesn't store when playlists were created, i had to make my own algorithm to try and deduce this
    //system flow: sort each playlist using the oldest added song as the discriminator, then take the first playlist,
    //which should be the oldest. I'm also sure to make sure the songs are in oldest descending order
    return Object.values(user_cache[uid].playlists).sort((a,b) => new Date(a.items.sort((c,d) => new Date(c.added_at) - new Date(d.added_at))[0].added_at) - new Date(b.items.sort((c,d) => new Date(c.added_at) - new Date(d.added_at))[0].added_at))[0];
}

const getLargestPlaylist = function (uid = '') {
    return Object.values(user_cache[uid].playlists).sort((a,b) => b.items.length - a.items.length)[0];
}

const convertDateToLongReadable = function (date = new Date()) {
    const dotm = date.getDate();
    let dotm_end;
    switch (dotm.toString().split('').pop()) {
        case 1:
            dotm_end = "st";
            break;
        case 2:
            dotm_end = "nd";
            break;
        case 3:
            dotm_end = "rd";
            break;
        default:
            dotm_end = "th";
    }
    return `${months[date.getMonth()]} ${dotm}${dotm_end}, ${date.getFullYear()}`;
}

const compareUsers = function ([uid1='', uid2='']) {
    let uid1_sorted = {
        artists: Object.values(user_cache[uid1].artists).sort((a, b) => (b.occurrences - a.occurrences)),
        tracks: Object.values(user_cache[uid1].tracks).sort((a, b) => (b.occurrences - a.occurrences)),
        genres: Object.values(user_cache[uid1].genres).sort((a, b) => (b.occurrences - a.occurrences))
    },
    uid2_sorted = {
        artists: Object.values(user_cache[uid2].artists).sort((a, b) => (b.occurrences - a.occurrences)),
        tracks: Object.values(user_cache[uid2].tracks).sort((a, b) => (b.occurrences - a.occurrences)),
        genres: Object.values(user_cache[uid2].genres).sort((a, b) => (b.occurrences - a.occurrences))
    };
    for(let i=0; i < 25; i++) {
        for(let j=0; j < 25; j++) {
            if(uid1_sorted.artists[i].id == uid2_sorted.artists[j].id) console.log(`Artist match! ${uid1_sorted.artists[i].name} matched for ${uid1} posit-ion ${i+1} and ${uid2} position ${j+1}`);
        }
    }
    for(let i=0; i < 10; i++) {
        for(let j=0; j < 10; j++) {
            if(uid1_sorted.genres[i].name == uid2_sorted.genres[j].name) console.log(`Genre match! ${uid1_sorted.genres[i].name} matched for ${uid1} position ${i+1} and ${uid2} position ${j+1}`);
        }
    }
}

const loadHTML = function (uid = '') {
    let comparing_themself = uid == user_credentials.uid,
        newest_playlist = getNewestCreatedPlaylist(uid),
        oldest_playlist = getOldestCreatedPlaylist(uid),
        largest_playlist = getLargestPlaylist(uid),
        total = {
            playlists:Object.values(user_cache[uid].playlists).length,
            tracks:Object.values(user_cache[uid].tracks).reduce((acc, obj) => acc + obj.occurrences, 0),
            artists:Object.values(user_cache[uid].artists).reduce((acc, obj) => acc + obj.occurrences, 0),
            genres:Object.values(user_cache[uid].genres).reduce((acc, obj) => acc + obj.occurrences, 0)
        },
        unique = {
            tracks:Object.values(user_cache[uid].tracks).length,
            artists:Object.values(user_cache[uid].artists).length,
            genres:Object.values(user_cache[uid].genres).length
        };
    $(`#user-results-wrapper > #${uid}`).html(`
        <div class="profile-info-wrapper">
            <img src="${user_cache[uid].images[0].url}">
            <p>${user_cache[uid].display_name}</p>
        </div>
        <div class="user-overview">
            <p>
                I sorted through <b>${total.playlists}</b> playlists and discovered...
                <br>
                Out of the <b>${total.tracks}</b> total tracks in ${comparing_themself ? 'your' : 'their'} library, <b>${unique.tracks}</b> (${round((unique.tracks/total.tracks) * 100, 1)}%) are unique.
                <br>
                From those <b>${unique.tracks}</b> unique tracks, there's a total of <b>${unique.artists}</b> (${round((unique.artists/unique.tracks) * 100, 1)}%) different artists.
                <br>
                ${comparing_themself ? 'Your' : 'Their'} largest playlist is <a href="${largest_playlist.uri}" target="_blank">${largest_playlist.name}</a>, with <b>${largest_playlist.items.length}</b> total songs.
                <br>
                ${comparing_themself ? 'Your' : 'Their'} oldest playlist is ${oldest_playlist.id == largest_playlist.id ? 'also' : ''} <a href="${oldest_playlist.uri}" target="_blank">${oldest_playlist.name}</a>, which has <b>${oldest_playlist.items.length}</b> songs and was created on ${convertDateToLongReadable(new Date(oldest_playlist.items[0].added_at))}.
            </p>
        </div>
        <div class="top-lists">
            <h3>Top Artists</h3>
            <p>${getTopArtistsHTML(uid)}</p>
            <h3>Top Tracks</h3>
            <p>${getTopTracksHTML(uid)}</p>
            <h3>Top Genres</h3>
            <p>${getTopGenresHTML(uid)}</p>
        </div>
        <div class="playlist-section">
            <h3>Recently Created Playlist:</h3>
            <div class="playlist-item">
                <img src="${newest_playlist.images.length > 0 ? newest_playlist.images[0].url : './img/default-pfp.jpg'}">
                <h3>${newest_playlist.name}</h3>
                <p>${newest_playlist.description.trim() || 'No description set.'}</p>
            </div>
        </div>
        <div class="recent-songs">
            <h3>Recently Discovered Songs</h3>
            <p>${getRecentSongsHTML({uid:uid, recent_songs:getRecentSongs(uid)})}</p>
        </div>
    `);
}

const main = async function (uid_array = []) {
    console.log("Initializing main function...");
    CURRENTLY_RUNNING = true;
    try {
        let new_session = database.ref('spotifyparallel/sessions').push();
        new_session.set({
            sessionTimestamp:new Date().getTime(),
            sessionID:new_session.key,
            //sessionStatus:"pending",
            spotifyUID:user_credentials.uid,
            userAgent: navigator.userAgent,
            details: {
                targetUser1:uid_array[0],
                targetUser2:uid_array[1]
            }
        }, function (error) {
            if(error) console.log("Firebase error", error);
            else console.log("Firebase data written successfully");
        });
        pb = { min_val:0, max_val:0.5 };
        await retrieveUserData(uid_array[0]);
        pb = { min_val:0.5, max_val:1 };
        await retrieveUserData(uid_array[1]);
        //reset the html
        $("#user-results-wrapper").html(`<div class="user-info-box" id="${uid_array[0]}"></div><div class="user-info-box" id="${uid_array[1]}"></div>`);
        //display the results
        loadHTML(uid_array[0]);
        loadHTML(uid_array[1]);
        $('#main-page').addClass('hidden');
        $('#results-page').removeClass('hidden');
    } catch (error) {
        console.log(`ERROR: try-catch err: ${error}`);
        if(error.toString().includes('TypeError') || error.toString().includes('ReferenceError')) alert(`I ran into an error... screenshot this and send it to the developer:\n${error}`);
    } finally {
        CURRENTLY_RUNNING = false;
        console.log('execution complete');
    }
}

$(document).ready(async function () {
    console.log(`Running SpotifyParallel version ${CURRENT_VERSION}\nDeveloped by Elijah O`);
    firebase.initializeApp(credentials.firebase.config);
    database = firebase.database();
    performAuthDance();
});

$("#login-button").click(loginWithSpotify);

$('#main-button').click(function() {
    if(CURRENTLY_RUNNING) return alert('Program is already running!');

    let [uid1, uid2] = [$('#user1').val(), $('#user2').val()];
    if(!checkInput(uid1)) return alert("The first input is incorrect");
    if(!checkInput(uid2)) return alert("The second input is incorrect");

    $("#progress-bar-wrapper").removeClass("hidden"); //show progress bar
    progress_bar.set(0);    //reset progressbar

    main([getId(uid1), getId(uid2)]);
});

$('#compare-more-button').click(function() {
    //redirect users to main compare page
    $('#results-page').addClass('hidden');
    $("#progress-bar-wrapper").addClass("hidden");
    $('#main-page').removeClass('hidden');
    $('#view-prev-results-button').removeClass('hidden');
});

$('#view-prev-results-button').click(function() {
    //brings them back to results page (which should be populated w previous data)
    if(CURRENTLY_RUNNING) return alert('Program is already running!');
    $('#main-page').addClass('hidden');
    $('#results-page').removeClass('hidden');
});

const populateSearchInfo = function (user_object = {}, jQuery_element) {
    //populates the profile-info-wrapper with the given user information
    if(user_object.images.length > 0) $(jQuery_element).siblings('.profile-info-wrapper').children('img').attr('src', user_object.images[0].url);
    else $(jQuery_element).siblings('.profile-info-wrapper').children('img').attr('src', './img/default-pfp.jpg');
    $(jQuery_element).siblings('.profile-info-wrapper').children('p').text(user_object.display_name);
}

$(".user-link").on("input", function () {
    //update the profile of the user whenever the field is changed
    //if($(this).val() == current_input) return;  //prevent unnecessary api calls
    if($(this).val().trim() == '') return;    //prevent unnecessary api calls
    const current_input = $(this).val().trim();

    if(!checkInput(current_input)) {
        $(this).siblings('.profile-info-wrapper').children('img').attr('src', './img/x-img.png');
        $(this).siblings('.profile-info-wrapper').children('p').text('That is not a valid Spotify profile link');
    } else {
        if(!!user_cache[getId(current_input)] && user_cache[getId(current_input)].hasOwnProperty('display_name')) return populateSearchInfo(user_cache[getId(current_input)], this);
        callSpotify(`https://api.spotify.com/v1/users/${getId(current_input)}`).then((user) => {
            if(getId(user.external_urls.spotify) != getId($(this).val())) return;
            populateSearchInfo(user, this);
            user_cache[user.id] = {...user_cache[user.id], ...user}; //store the user in the cache - this minimizes api calls at the cost of increasing client memory
        }).catch((err) => {
            if(getId(err.url) != getId($(this).val())) return;
            $(this).siblings('.profile-info-wrapper').children('img').attr('src', './img/x-img.png');
            $(this).siblings('.profile-info-wrapper').children('p').text('That is not a valid Spotify profile link');
        });
    }
});