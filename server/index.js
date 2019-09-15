const config = require('./config.js')
const fs = require('fs')
const uuidv1 = require('uuid/v1')
const moment = require('moment')
const express = require('express')
const https = require('https')
const http = require('http')
const enforce = require('express-sslify')
const steem = require('steem')
const javalon = require('javalon')
const emails = require('./emails.js')
const captcha = require('./captcha.js')
const sms = require('./sms.js')
const fb = require('./facebook.js')
const usernameValidation = require('./username_validation.js')
const STEEM_DTC = 0.67

var coinbase = require('coinbase-commerce-node')
var Client = coinbase.Client
Client.init(config.coinbase.apiKey)
var Charge = coinbase.resources.Charge
var Webhook = coinbase.Webhook

const MongoClient = require('mongodb').MongoClient
const mongoUrl = 'mongodb://localhost:27017'
const mongoDbName = 'signup'

const port = process.env.PORT || 3000
const port_ssl = process.env.PORT_SSL || 443
const debug = process.env.DEBUG || false

process.on('SIGINT', function() {
    if (typeof ending !== 'undefined') return
    ending = true
    process.exit()
})

// express server
const app = express()
app.use(express.urlencoded())
app.use(express.json())
app.use(express.static('client',{ dotfiles: 'allow' }))
app.use(fb.initialize());
app.use(fb.session());
app.enable('trust proxy')

db = null
MongoClient.connect(mongoUrl, { useNewUrlParser: true }, function(err, client) {
    if (err) throw err;
    console.log("Connected successfully to database");
    db = client.db(mongoDbName);
    http.createServer(app).listen(port, () => {
        if (config.ssl) {
            const privateKey = fs.readFileSync('/etc/letsencrypt/live/'+config.domain+'/privkey.pem', 'utf8');
            const certificate = fs.readFileSync('/etc/letsencrypt/live/'+config.domain+'/cert.pem', 'utf8');
            const ca = fs.readFileSync('/etc/letsencrypt/live/'+config.domain+'/chain.pem', 'utf8');
            
            const credentials = {
                key: privateKey,
                cert: certificate,
                ca: ca
            };
        
            console.log('SSL enabled')
            //app.use(enforce.HTTPS({ trustProtoHeader: true }))
            https.createServer(credentials, app).listen(port_ssl, () => {
                console.log(`HTTPS Server listening on port ${port_ssl}!`)
            })
        }  
        console.log(`HTTP Server listening on port ${port}!`)

        // captcha + email verification
        app.post('/', function (req, res) {
            if (!req.body.email || !req.body['h-captcha-response'] || !req.body.birth) {
                res.status(400).send('Missing information')
                return
            }
            var years = moment().diff(req.body.birth, 'years')
            if (years < 13) {
                res.redirect('/?kid')
                return
            }
            captcha.check(req.body['h-captcha-response'], function(err) {
                if (err) {
                    console.log(err)
                    res.status(503).send('Error verifying captcha')
                    return
                }
                var uuid = uuidv1()
                emails.send(req.body.email, 'DTube Signup', uuid, function(err, success) {
                    if (!err) {
                        db.collection('tokens').insertOne({
                            _id: uuid,
                            email: req.body.email,
                            birth: req.body.birth,
                            ts: new Date().getTime()
                        }, function(err) {
                            if (err) throw err;
                            res.redirect('/?ok')
                        })
                    } else { 
                        console.log(err)
                        res.status(503).send('Error sending email')
                    }
                })
            })
        })

        // user clicks the email link
        app.get('/signup/:uuid', function (req, res) {
            verifToken(req, res, function(token) {
                if (!token) return
                db.collection('account').findOne({email: token.email}, function(err, acc) {
                    if (err) {
                        res.status(503).send('Database error')
                        return
                    }
                    if (!acc) {
                        var acc = {
                            email: token.email,
                            birth: token.birth,
                            startTime: new Date().getTime()
                        }
                        db.collection('account').insertOne(acc)
                        res.send(acc)
                    } else
                        res.send(acc)
                })
            })
        })

        // user submits personal info
        app.post('/personalInfo/:uuid', function (req, res) {
            if (!req.params.uuid || !req.body.personal_info) {
                res.status(503).send('Missing information')
                return
            }
            var info = req.body.personal_info
            if (!info.postal || !info.country) {
                res.status(503).send('Missing information')
                return
            }
            verifToken(req, res, function(token) {
                if (!token) return
                db.collection('account').updateOne({email: token.email}, {
                    $set: {personal_info: req.body.personal_info}
                }, function() {
                    res.send()
                })
            })
        })

        // facebook connect
        app.get('/skipFb/:uuid', function(req, res) {
            if (!req.params.uuid) {
                res.status(503).send('Missing information')
                return
            }
            verifToken(req, res, function(token) {
                if (!token) return

                db.collection('account').updateOne({email: token.email}, {
                    $set: {facebook: 'skip'}
                }, function() {
                    res.send()
                })
            })
        })

        app.get('/auth/facebook',
            fb.authenticate('facebook')
        );
        
        app.get('/auth/facebook/callback',
        fb.authenticate('facebook', { failureRedirect: '/error' }),
        function(req, res) {
            // Successful authentication, redirect home.
            res.redirect('/?fb='+req.user.accessToken);
        });

        app.get('/linkFacebook/:token/:uuid', function(req, res) {
            if (!req.params.token || !req.params.uuid) {
                res.status(503).send('Missing information')
                return
            }
            verifToken(req, res, function(token) {
                if (!token) return

                db.collection('facebook').findOne({accessToken: req.params.token}, function(err, facebook) {
                    if (!facebook) {
                        res.status(503).send('Error linking facebook')
                        return
                    }
                    db.collection('account').updateOne({email: token.email}, {
                        $set: {facebook: facebook}
                    }, function() {
                        res.send()
                    })
                })
                
            })
        })

        app.get('/skipSms/:uuid', function(req, res) {
            if (!req.params.uuid) {
                res.status(503).send('Missing information')
                return
            }
            verifToken(req, res, function(token) {
                if (!token) return

                db.collection('account').updateOne({email: token.email}, {
                    $set: {phone: 'skip'}
                }, function() {
                    res.send()
                })
            })
        })

        // user submits phone number, we send a code
        app.post('/smsCode/:uuid', function (req, res) {
            if (!req.params.uuid || !req.body.phone) {
                res.status(503).send('Missing information')
                return
            }
            console.log(req.body.phone)
            verifToken(req, res, function(token) {
                if (!token) return

                var code = Math.floor(100000+Math.random()*900000)
                db.collection('phone').deleteMany({
                    phone: req.body.phone
                }, function() {
                    db.collection('phone').insertOne({
                        phone: req.body.phone,
                        code: code,
                        ts: new Date().getTime()
                    })
                })
                var message = 'Verification code: '+code+'. Make sure the domain in your address bar is \'d.tube\' before proceeding.'
                sms.send(req.body.phone, message)
                res.send()
            })
        })

        // user submits the code he received
        app.post('/smsVerify/:uuid', function(req, res) {
            if (!req.params.uuid || !req.body.code || !req.body.phone) {
                res.status(503).send('Missing information')
                return
            }
            verifToken(req, res, function(token) {
                if (!token) return
                
                db.collection('phone').findOne({
                    phone: req.body.phone,
                    code: parseInt(req.body.code)
                }, function(err, phone) {
                    if (!phone) {
                        res.status(503).send('Error verifying phone number')
                        return
                    }
                    db.collection('account').updateOne({
                        email: token.email
                    }, {
                        $set: {phone: req.body.phone}
                    })
                    res.send()
                })
            })
        })

        // user submits his new public key he jsut generated
        app.post('/confirmKeys/:uuid', function(req, res) {
            if (!req.params.uuid || !req.body.pub) {
                res.status(503).send('Missing information')
                return
            }
            verifToken(req, res, function(token) {
                if (!token) return

                db.collection('account').updateOne({
                    email: token.email
                }, {
                    $set: {pub: req.body.pub}
                })
                res.send()
            })
        })

        // user submits a username
        app.post('/chooseUsername/:uuid', function(req, res) {
            if (!req.params.uuid || !req.body.username) {
                res.status(503).send('Missing information')
                return
            }
            req.body.username = req.body.username.trim().toLowerCase()
            if (req.body.username.length < 9) {
                res.status(503).send('Username too short')
                return
            }
            if (req.body.username.replace(/[^0-9]/g,"").length < 2) {
                res.status(503).send('Username needs to contain at least two digits')
                return
            }
            if (!usernameValidation(
                req.body.username,
                50,
                1,
                'abcdefghijklmnopqrstuvwxyz0123456789',
                '-.'
            )) {
                res.status(503).send('Invalid username')
                return
            }
            verifToken(req, res, function(token) {
                if (!token) return

                steem.api.getAccounts([req.body.username], function(err, accounts) {
                    if (err) {
                        res.status(503).send('Steem API error')
                        return
                    }
                    if (accounts.length > 0) {
                        res.status(503).send('Username already taken on STEEM')
                        return
                    }
                    javalon.getAccounts([req.body.username], function(err, accounts) {
                        if (err) {
                            res.status(503).send('Avalon API error')
                            return
                        }
                        if (accounts.length > 0) {
                            res.status(503).send('Username already taken on Avalon')
                            return
                        }
                        db.collection('account').updateOne({
                            email: token.email
                        }, {
                            $set: {username: req.body.username}
                        })
                        res.send()
                    })
                })
            })
        })

        // user finalizes his account
        // user submits a username
        app.post('/createAccount/:uuid', function(req, res) {
            console.log(req.params)
            if (!req.params.uuid || !req.body.optin) {
                res.status(503).send('Missing information')
                return
            }
            verifToken(req, res, function(token) {
                if (!token) return

                db.collection('account').updateOne({
                    email: token.email
                }, {
                    $set: {
                        optin: req.body.optin,
                        finalized: true
                    }
                })
                res.send()
            })
        })

        // token sale coinbase
        app.post('/buyOther/', function(req, res) {
            var price = 0.10*parseInt(req.body.amount)
            price = price.toFixed(2)
            var chargeData = {
                'name': 'DTC Round 1',
                'description': req.body.amount+' DTC to @'+req.body.username,
                'pricing_type': 'fixed_price',
                'logo_url': 'https://res.cloudinary.com/commerce/image/upload/v1568140129/sh8bxamfsyrmuwtbut4w.png',
                'local_price': {
                    'amount': price,
                    'currency': 'USD'
                }
            }
            Charge.create(chargeData, function (error, charge) {
                if (error) {
                    res.status(503).send('Coinbase error')
                    return
                }
                res.send(charge.code)
                console.log('New Coinbase Charge '+req.body.amount+' DTC '+charge.code)
                charge.personal_info = req.body
                db.collection('charges').insertOne(charge)
                
            });
        })

        // token sale steem
        app.post('/buySteem/', function(req, res) {
            var price = STEEM_DTC*parseInt(req.body.amount)
            price = price.toFixed(3)
            console.log('New Steem Charge '+req.body.amount+' DTC ')
            var charge = {
                price: price,
                ts: new Date().getTime(),
                uuid: uuidv1(),
            }
            res.send(charge)
            charge.personal_info = req.body
            db.collection('charges').insertOne(charge)
        })

        // coinbase verify payments
        app.post('/webhook/', function(req, res) {
            var signature = req.headers['x-cc-webhook-signature']
            //console.log(signature, req.body)
            try {
                event = Webhook.verifyEventBody(
                        JSON.stringify(req.body),
                        signature,
                        config.coinbase.secret
                );
            } catch (error) {
                console.log('Error occured', error.message);
                res.status(400).send('Webhook Error:' + error.message);
                return;
            }
            res.send('Signed Webhook Received: ' + event.id);
            var status = event.type
            console.log('Coinbase '+status+' '+event.data.code)
            db.collection('charges').updateOne({id: event.data.id}, {"$set": {
                "status": status,
                "timeline": event.data.timeline
            }})
        })
    })
})

function verifToken(req, res, cb) {
    var ip_addr = req.headers['x-forwarded-for'] || req.connection.remoteAddress
    db.collection('tokens').findOne({_id: req.params.uuid}, function(err, token) {
        if (err || !token) {
            res.status(503).send('Error verifying uuid')
            cb(null)
            return
        }
        cb(token)

        if (!token.ip || token.ip.indexOf(ip_addr) === -1) {
            db.collection('tokens').updateOne({_id: token._id}, {
                "$push": {ip: ip_addr}
            })
        }
    })
}